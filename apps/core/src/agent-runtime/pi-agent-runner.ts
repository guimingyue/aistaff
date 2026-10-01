import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDwsTools } from '../agent-tools/dws-tools';
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

/** 未设置/非法值都回落到 pi 的内置默认，避免因配置写法把压缩关掉。 */
function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * pi 的上下文压缩配置（默认开启）：每次请求前按 `contextTokens > contextWindow - reserveTokens`
 * 判定，命中则把较早的条目摘要成一条 compactionSummary、保留最近 keepRecentTokens 原文、重载会话。
 * 关掉它长会话迟早撑爆上下文窗口而无法工作，因此只保留开关与两个阈值的调节口。
 */
export function compactionSettingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
  return {
    enabled: env.AISTAFF_AGENT_COMPACTION !== '0',
    reserveTokens: positiveInt(env.AISTAFF_AGENT_COMPACTION_RESERVE_TOKENS, 16_384),
    keepRecentTokens: positiveInt(env.AISTAFF_AGENT_COMPACTION_KEEP_TOKENS, 20_000),
  };
}

/**
 * 组织侧工具注册条件：员工显式声明了工具白名单，且三方账号绑定校验通过（有专属 CLI profile）。
 * 未声明 tools 的默认档沿用 pi 内置工具，不因代码升级就凭空获得触碰组织系统的入口。
 */
export function shouldRegisterOrgTools(req: Pick<RunTurnRequest, 'cliEnv' | 'tools'>): boolean {
  return Boolean(req.cliEnv && req.tools && req.tools.length > 0);
}

/**
 * 模型是否接受图片输入。pi 对不支持图像的模型会静默省略图片附件，员工就会"没看见图还照答"，
 * 所以带图的轮次必须在发请求之前显式拒绝。
 */
export function modelAcceptsImages(model: { input?: readonly string[] } | undefined): boolean {
  return Boolean(model?.input?.includes('image'));
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
      compaction: compactionSettingsFromEnv(),
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
    // 组织侧工具只在员工显式声明工具白名单且账号绑定校验通过时注册
    if (shouldRegisterOrgTools(req)) {
      Object.assign(options, {
        customTools: createDwsTools({ bin: process.env.AISTAFF_DWS_BIN ?? 'dws', env: req.cliEnv! }) as never,
      });
    }

    const { session } = await pi.createAgentSession(options);
    if (req.images?.length && session.model && !modelAcceptsImages(session.model)) {
      session.dispose();
      throw new Error(
        `model ${session.model.provider}/${session.model.id} does not accept image input; attach images only to a vision-capable model`,
      );
    }
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
          } else if (ev.type === 'compaction_end') {
            emit({
              type: 'compaction',
              reason: ev.reason,
              ok: !ev.aborted && !ev.errorMessage,
              tokensBefore: ev.result?.tokensBefore,
              estimatedTokensAfter: ev.result?.estimatedTokensAfter,
              errorMessage: ev.errorMessage,
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
      await session.prompt(req.message, req.images?.length ? { images: req.images } : undefined);
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
