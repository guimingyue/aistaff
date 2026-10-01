import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DingtalkAdapter, isolatedEnv } from '../connections/dingtalk.adapter';
import { runCli, parseJsonLoose, cliIdArg, cliTextArg } from '../connections/cli-invoker';
import { InboundMessage, InboundMedia, LoopChannel, LoopProvider } from './channel';
import { mediaLimitsFromEnv, parseResourceLedger, readImagesFromLedger } from './media';

/** 图片落盘子目录：平台生成的常量，绝不来自消息内容 */
const MEDIA_SUBDIR = 'inbox';

interface AtEventPayload {
  type?: string;
  event_id?: string;
  message_id?: string;
  conversation_id?: string;
  content?: string;
  sender?: string;
  sender_open_dingtalk_id?: string;
}

/**
 * 钉钉 @消息闭环通道（设计 §5.3）：
 * 接收 = `dws event consume user_im_message_receive_at --flatten`（个人事件长连接，NDJSON）；
 * 发送 = `dws chat message send --group=<openConversationId> --content=<文本>`（以员工身份回发）。
 * 停止按官方纪律 SIGTERM/关 stdin，绝不 kill -9（会泄漏服务端订阅）。
 */
export class DwsAtChannel implements LoopChannel {
  private child?: ChildProcessWithoutNullStreams;

  constructor(
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async start(handlers: {
    onMessage(msg: InboundMessage): void;
    onDiagnostic(line: string): void;
    onExit(code: number | null): void;
  }): Promise<void> {
    const child = spawn(
      this.bin,
      ['event', 'consume', 'user_im_message_receive_at', '--flatten'],
      { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;

    createInterface({ input: child.stdout }).on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload: AtEventPayload | null = null;
      try {
        payload = JSON.parse(trimmed) as AtEventPayload;
      } catch {
        handlers.onDiagnostic(`non-JSON output line: ${trimmed.slice(0, 200)}`);
        return;
      }
      if (payload?.type !== 'user_im_message_receive_at' || !payload.event_id || !payload.conversation_id) {
        handlers.onDiagnostic(`ignored non-@message event line: ${trimmed.slice(0, 200)}`);
        return;
      }
      handlers.onMessage({
        eventId: payload.event_id,
        messageId: payload.message_id,
        conversationId: payload.conversation_id,
        senderName: payload.sender,
        senderOpenDingTalkId: payload.sender_open_dingtalk_id,
        content: payload.content ?? '',
      });
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (line.trim()) handlers.onDiagnostic(line.trim().slice(0, 400));
    });
    child.on('error', (err) => {
      handlers.onDiagnostic(`child process error: ${err.message}`);
      this.child = undefined;
      handlers.onExit(-1);
    });
    child.on('close', (code) => {
      this.child = undefined;
      handlers.onExit(code);
    });
    // spawn 失败（ENOENT 等）以 error/close 事件异步到达，让出一拍后即可认为通道已挂载
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async send(conversationId: string, text: string): Promise<void> {
    const res = await runCli(
      this.bin,
      ['chat', 'message', 'send', cliIdArg('group', conversationId), cliTextArg('content', text), '-y', '-f', 'json'],
      this.env,
    );
    const parsed = parseJsonLoose(res.stdout) as { success?: boolean } | null;
    if (res.code !== 0 || parsed?.success === false) {
      throw new Error(`dingtalk send failed (exit=${res.code}): ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
  }

  /**
   * 取回一条消息附带的图片：`chat +messages-mget --download-resources` 把工作目录内的相对路径
   * 落盘并回逐资源台账，因此 CLI 的工作目录必须是该员工的 workspace（cwd 参数）。
   * 台账只分 mediaId/fileId，不区分图片与视频，类型判定交给文件头。
   */
  async fetchImages(messageId: string, workspaceDir: string): Promise<InboundMedia> {
    // CLI 以 workspaceDir 为工作目录（--output-dir 只收相对路径），首轮时目录可能还不存在
    mkdirSync(workspaceDir, { recursive: true });
    const res = await runCli(
      this.bin,
      [
        'chat',
        '+messages-mget',
        cliIdArg('msg-ids', messageId),
        '--download-resources',
        '--no-threads',
        '--no-reactions',
        `--output-dir=${MEDIA_SUBDIR}`,
        '-f',
        'json',
      ],
      this.env,
      workspaceDir,
    );
    if (res.code !== 0) {
      throw new Error(
        `dingtalk resource download failed (exit=${res.code}): ${(res.stderr || res.stdout).slice(0, 300)}`,
      );
    }
    const ledger = parseResourceLedger(parseJsonLoose(res.stdout));
    const images = await readImagesFromLedger(ledger, workspaceDir, mediaLimitsFromEnv());
    return {
      images,
      discoveredCount: ledger.discoveredCount,
      skippedCount: Math.max(ledger.discoveredCount - images.length, 0),
    };
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      setTimeout(resolve, 10_000);
    });
  }
}

export function dingtalkLoopProvider(bin: string): LoopProvider {
  return {
    async authStatus(profileDir: string) {
      const adapter = new DingtalkAdapter(bin, isolatedEnv(profileDir));
      return (await adapter.authStatus()).authenticated;
    },
    channel(profileDir: string) {
      return new DwsAtChannel(bin, isolatedEnv(profileDir));
    },
  };
}
