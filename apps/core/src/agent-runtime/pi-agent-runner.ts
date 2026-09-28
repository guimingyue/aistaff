import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRunner, RunTurnRequest, RunTurnResult } from './agent-runner';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

function preview(value: unknown, max: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

let sdkPromise: Promise<PiSdk> | undefined;
function loadSdk(): Promise<PiSdk> {
  if (!sdkPromise) {
    sdkPromise = import('@earendil-works/pi-coding-agent');
  }
  return sdkPromise;
}

/**
 * pi-coding-agent 库化封装（服务端进程内运行，非 CLI 子进程）。
 * 模型凭证为平台级配置：AISTAFF_MODEL_API_KEY（配 AISTAFF_MODEL_PROVIDER，缺省 anthropic）
 * 注入运行时；未配置时回落 pi 自身的 auth.json / 环境变量链。
 */
export class PiAgentRunner implements AgentRunner {
  readonly kind = 'pi';

  private modelRuntime?: Promise<unknown>;

  private getModelRuntime(pi: PiSdk, runtimeDir: string): Promise<unknown> {
    if (!this.modelRuntime) {
      this.modelRuntime = (async () => {
        mkdirSync(runtimeDir, { recursive: true });
        const runtime = await pi.ModelRuntime.create({
          authPath: resolve(runtimeDir, 'auth.json'),
          modelsPath: resolve(runtimeDir, 'models.json'),
        });
        const key = process.env.AISTAFF_MODEL_API_KEY;
        if (key) {
          const provider = process.env.AISTAFF_MODEL_PROVIDER ?? 'anthropic';
          await runtime.setRuntimeApiKey(provider, key);
        }
        return runtime;
      })();
    }
    return this.modelRuntime;
  }

  async runTurn(req: RunTurnRequest): Promise<RunTurnResult> {
    if (req.signal?.aborted) {
      throw new Error(`employee ${req.employeeNo}: agent turn cancelled before start`);
    }
    const pi = await loadSdk();
    mkdirSync(req.workspaceDir, { recursive: true });
    const agentDir = resolve(req.workspaceDir, '.aistaff-agent');
    const sessionDir = resolve(agentDir, 'sessions');
    mkdirSync(sessionDir, { recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runtime: any = await this.getModelRuntime(pi, resolve(agentDir, 'model-runtime'));

    let model;
    let modelUsed: string | undefined;
    if (req.model) {
      const resolved = pi.resolveCliModel({ cliModel: req.model, modelRuntime: runtime });
      if (resolved.error || !resolved.model) {
        throw new Error(`failed to resolve model "${req.model}": ${resolved.error ?? 'no matching model'}`);
      }
      model = resolved.model;
      modelUsed = `${resolved.model.provider}/${resolved.model.id}`;
    }

    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: false },
    });

    const loader = new pi.DefaultResourceLoader({
      cwd: req.workspaceDir,
      agentDir,
      settingsManager,
      systemPrompt: req.systemPrompt,
      noExtensions: true,
      noContextFiles: true,
    });
    await loader.reload();

    const sessionManager = req.sessionFile
      ? pi.SessionManager.open(req.sessionFile)
      : pi.SessionManager.create(req.workspaceDir, sessionDir);

    const options: Parameters<typeof pi.createAgentSession>[0] = {
      cwd: req.workspaceDir,
      agentDir,
      modelRuntime: runtime as never,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
    };
    // thinking 由开关在源头决定：关闭时 pi 不产生任何思考内容，事件流中也不会出现 thinking
    const showThinking = process.env.AISTAFF_SHOW_THINKING === '1';
    if (model) Object.assign(options, { model });
    Object.assign(options, { thinkingLevel: showThinking ? 'medium' : 'off' });
    if (req.tools) {
      if (req.tools.length === 0) {
        Object.assign(options, { noTools: 'all' as const });
      } else {
        Object.assign(options, { tools: req.tools });
      }
    }

    const { session } = await pi.createAgentSession(options);
    const emit = req.onEvent;
    const unsubscribe = emit
      ? session.subscribe((ev) => {
          if (ev.type === 'tool_execution_start') {
            emit({ type: 'tool_call', toolName: ev.toolName, argsPreview: preview(ev.args, 200) });
          } else if (ev.type === 'tool_execution_end') {
            emit({
              type: 'tool_result',
              toolName: ev.toolName,
              isError: Boolean(ev.isError),
              resultPreview: preview(ev.result, 400),
            });
          } else if (ev.type === 'message_update') {
            const aev = ev.assistantMessageEvent as { type: string; content?: string };
            if (aev.type === 'thinking_end' && aev.content?.trim()) {
              emit({ type: 'thinking', text: aev.content });
            }
          }
        })
      : undefined;
    // 超时/停机取消：pi 的 prompt 不接受 signal，用 abort() 打断后按取消语义抛错
    const onAbort = req.signal ? () => void session.abort() : undefined;
    if (req.signal && onAbort) {
      if (req.signal.aborted) {
        session.dispose();
        throw new Error(`employee ${req.employeeNo}: agent turn cancelled`);
      }
      req.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      await session.prompt(req.message);
      if (req.signal?.aborted) {
        throw new Error(`employee ${req.employeeNo}: agent turn cancelled`);
      }
      const replyText = session.getLastAssistantText() ?? '';
      if (!replyText.trim()) {
        throw new Error(`employee ${req.employeeNo}: agent turn produced no text reply`);
      }
      const finalSessionFile = sessionManager.getSessionFile() ?? req.sessionFile;
      if (!finalSessionFile) {
        throw new Error(`employee ${req.employeeNo}: pi session file was not persisted (no session path)`);
      }
      return { replyText, sessionFile: finalSessionFile, modelUsed };
    } finally {
      if (req.signal && onAbort) req.signal.removeEventListener('abort', onAbort);
      unsubscribe?.();
      session.dispose();
    }
  }
}
