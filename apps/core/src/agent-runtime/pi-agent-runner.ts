import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRunner, RunTurnRequest, RunTurnResult } from './agent-runner';

type PiSdk = typeof import('@earendil-works/pi-coding-agent');

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
        throw new Error(`模型解析失败（${req.model}）：${resolved.error ?? '无匹配模型'}`);
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
    if (model) Object.assign(options, { model, thinkingLevel: 'off' });
    if (req.tools) {
      if (req.tools.length === 0) {
        Object.assign(options, { noTools: 'all' as const });
      } else {
        Object.assign(options, { tools: req.tools });
      }
    }

    const { session } = await pi.createAgentSession(options);
    try {
      await session.prompt(req.message);
      const replyText = session.getLastAssistantText() ?? '';
      if (!replyText.trim()) {
        throw new Error(`员工 ${req.employeeNo} 的 Agent 本轮没有产出文本回复`);
      }
      const finalSessionFile = sessionManager.getSessionFile() ?? req.sessionFile;
      if (!finalSessionFile) {
        throw new Error(`员工 ${req.employeeNo} 的 pi 会话未落盘（无会话档案路径）`);
      }
      return { replyText, sessionFile: finalSessionFile, modelUsed };
    } finally {
      session.dispose();
    }
  }
}
