import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DingtalkAdapter, isolatedEnv } from '../connections/dingtalk.adapter';
import { runCli, parseJsonLoose } from '../connections/cli-invoker';
import { InboundMessage, LoopChannel, LoopProvider } from './channel';

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
 * 发送 = `dws chat message send --group <openConversationId> --text ...`（以员工身份回发）。
 * 停止按官方纪律 SIGTERM/关 stdin，绝不 kill -9（会泄漏服务端订阅）。
 */
class DwsAtChannel implements LoopChannel {
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
        handlers.onDiagnostic(`非 JSON 输出行: ${trimmed.slice(0, 200)}`);
        return;
      }
      if (payload?.type !== 'user_im_message_receive_at' || !payload.event_id || !payload.conversation_id) {
        handlers.onDiagnostic(`忽略非 @消息事件行: ${trimmed.slice(0, 200)}`);
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
      handlers.onDiagnostic(`子进程错误: ${err.message}`);
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
      ['chat', 'message', 'send', '--group', conversationId, '--text', text, '-y', '-f', 'json'],
      this.env,
    );
    const parsed = parseJsonLoose(res.stdout) as { success?: boolean } | null;
    if (res.code !== 0 || parsed?.success === false) {
      throw new Error(`钉钉回发失败 (exit=${res.code}): ${(res.stderr || res.stdout).slice(0, 300)}`);
    }
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
