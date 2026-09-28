import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ChatService } from '../agent-runtime/chat.service';
import { InboundMessage, LOOP_PROVIDERS, LoopChannel, LoopProvider } from './channel';

const UNSUPPORTED_NOTICE = '抱歉，我暂时只能处理文本消息，图片/富卡片等类型支持在后续版本开放。';
const TIMEOUT_NOTICE = '抱歉，这一轮处理超时了，请稍后再 @我 一次。';
const QUEUE_FULL_NOTICE = '抱歉，我这边积压较多，这条消息没有处理，请稍后再 @我。';

function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface RunningLoop {
  channel: LoopChannel;
  startedAt: string;
  seen: Set<string>;
  /** 每个「会话+发送人」一条串行链：同一对话不得并发跑，否则会争用同一份 Agent 会话档案 */
  chains: Map<string, Promise<void>>;
  abort: AbortController;
  queued: number;
  inflight: number;
  processed: number;
  errors: number;
  dropped: number;
  lastDiagnostic?: string;
}

@Injectable()
export class MessageLoopService {
  private readonly loops = new Map<string, RunningLoop>();
  /** 跨闭环的全局并发闸门：一轮 Agent 就是一条模型长连接，必须有上限 */
  private slotsInUse = 0;
  private readonly slotWaiters: Array<() => void> = [];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(LOOP_PROVIDERS) private readonly providers: Partial<Record<'DINGTALK', LoopProvider>>,
  ) {}

  private profileDir(employeeNo: string): string {
    const dataDir = process.env.AISTAFF_DATA_DIR ?? resolve(process.cwd(), '..', '..', 'data');
    return resolve(dataDir, 'cli-profiles', `${employeeNo}-DINGTALK`);
  }

  async start(employeeNo: string, actor: string) {
    if (this.loops.has(employeeNo)) throw new Error(`message loop for employee ${employeeNo} is already running`);
    const employee = await this.prisma.staff.employee.findUnique({
      where: { employeeNo },
      include: { bindings: true, agentProfile: true },
    });
    if (!employee) throw new Error(`employee ${employeeNo} does not exist`);
    if (employee.status !== 'ACTIVE') throw new Error(`employee ${employeeNo} is ${employee.status}; only ACTIVE can start a loop`);
    if (employee.agentProfile?.status !== 'ENABLED') throw new Error(`employee ${employeeNo} has no enabled AgentProfile`);
    const binding = employee.bindings.find((b) => b.provider === 'DINGTALK');
    if (binding?.bindingStatus !== 'BOUND') {
      throw new Error(`employee ${employeeNo}: DINGTALK binding is not BOUND; complete binding verification first`);
    }
    const provider = this.providers.DINGTALK;
    if (!provider) throw new Error('DINGTALK loop channel is not configured');
    const dir = this.profileDir(employeeNo);
    if (!(await provider.authStatus(dir))) {
      throw new Error(`employee ${employeeNo}: DingTalk CLI profile is not logged in; run "aistaff login ${employeeNo}" first`);
    }

    const loop: RunningLoop = {
      channel: provider.channel(dir),
      startedAt: new Date().toISOString(),
      seen: new Set(),
      chains: new Map(),
      abort: new AbortController(),
      queued: 0,
      inflight: 0,
      processed: 0,
      errors: 0,
      dropped: 0,
    };
    this.loops.set(employeeNo, loop);
    await loop.channel.start({
      onMessage: (msg) => this.enqueue(employeeNo, loop, msg),
      onDiagnostic: (line) => {
        loop.lastDiagnostic = line;
      },
      onExit: async (code) => {
        if (this.loops.get(employeeNo) !== loop) return;
        this.loops.delete(employeeNo);
        await this.audit.record({
          actor: 'message-loop',
          action: 'loop.exit',
          target: employeeNo,
          detail: { code, processed: loop.processed, errors: loop.errors, dropped: loop.dropped, lastDiagnostic: loop.lastDiagnostic },
        });
      },
    });
    await this.audit.record({
      actor,
      action: 'loop.start',
      target: employeeNo,
      detail: { profileDir: dir, event: 'user_im_message_receive_at' },
    });
    return { employeeNo, running: true, startedAt: loop.startedAt };
  }

  private enqueue(employeeNo: string, loop: RunningLoop, msg: InboundMessage) {
    if (loop.abort.signal.aborted) return;
    if (loop.seen.has(msg.eventId)) return;
    if (loop.seen.size > 5000) loop.seen.clear();
    loop.seen.add(msg.eventId);

    const maxQueued = numEnv('AISTAFF_LOOP_MAX_QUEUED', 50);
    if (loop.queued >= maxQueued) {
      loop.dropped += 1;
      void this.audit.record({
        actor: 'message-loop',
        action: 'message.dropped',
        target: `${employeeNo}/${msg.conversationId}`,
        detail: { eventId: msg.eventId, reason: 'loop queue full', queued: loop.queued, limit: maxQueued },
      });
      void loop.channel.send(msg.conversationId, QUEUE_FULL_NOTICE).catch(() => undefined);
      return;
    }

    const key = `${msg.conversationId}|${msg.senderOpenDingTalkId ?? msg.senderName ?? 'unknown'}`;
    loop.queued += 1;
    const next = (loop.chains.get(key) ?? Promise.resolve())
      .then(() => this.runTurnGuarded(employeeNo, loop, msg))
      .catch(() => undefined)
      .then(() => {
        loop.queued -= 1;
        if (loop.chains.get(key) === next) loop.chains.delete(key);
      });
    loop.chains.set(key, next);
  }

  private async runTurnGuarded(employeeNo: string, loop: RunningLoop, msg: InboundMessage) {
    if (loop.abort.signal.aborted) return;
    const release = await this.acquireSlot();
    if (loop.abort.signal.aborted) {
      release();
      return;
    }
    loop.inflight += 1;
    try {
      await this.handle(employeeNo, loop, msg);
    } finally {
      loop.inflight -= 1;
      release();
    }
  }

  private acquireSlot(): Promise<() => void> {
    const limit = numEnv('AISTAFF_LOOP_MAX_CONCURRENT', 3);
    if (this.slotsInUse < limit) {
      this.slotsInUse += 1;
      return Promise.resolve(() => this.releaseSlot());
    }
    return new Promise<() => void>((grant) => {
      this.slotWaiters.push(() => grant(() => this.releaseSlot()));
    });
  }

  /** 释放的槽位直接交给最早的等待者，避免惊群与超额放行。 */
  private releaseSlot() {
    this.slotsInUse -= 1;
    const next = this.slotWaiters.shift();
    if (next) {
      this.slotsInUse += 1;
      next();
    }
  }

  private async handle(employeeNo: string, loop: RunningLoop, msg: InboundMessage) {
    const actor = `dingtalk:${msg.senderOpenDingTalkId ?? msg.senderName ?? 'unknown'}`;
    await this.audit.record({
      actor,
      action: 'message.inbound',
      target: `${employeeNo}/${msg.conversationId}`,
      detail: {
        eventId: msg.eventId,
        messageId: msg.messageId ?? null,
        sender: msg.senderName ?? null,
        contentChars: msg.content.length,
        content: msg.content.slice(0, 500),
      },
    });
    const timeoutMs = numEnv('AISTAFF_LOOP_TURN_TIMEOUT_MS', 180_000);
    const turn = new AbortController();
    const onLoopAbort = () => turn.abort();
    loop.abort.signal.addEventListener('abort', onLoopAbort, { once: true });
    const timer = setTimeout(() => turn.abort(), timeoutMs);
    try {
      if (!msg.content.trim()) {
        await loop.channel.send(msg.conversationId, UNSUPPORTED_NOTICE);
        await this.audit.record({
          actor,
          action: 'message.outbound',
          target: `${employeeNo}/${msg.conversationId}`,
          detail: { eventId: msg.eventId, notice: 'unsupported-type', replyChars: UNSUPPORTED_NOTICE.length },
        });
        return;
      }
      const result = await this.chat.chat(employeeNo, msg.content, {
        actor,
        channel: 'DINGTALK',
        externalConversationId: msg.conversationId,
        senderExternalUserId: msg.senderOpenDingTalkId ?? msg.senderName ?? undefined,
        signal: turn.signal,
      });
      await loop.channel.send(msg.conversationId, result.replyText);
      loop.processed += 1;
      await this.audit.record({
        actor,
        action: 'message.outbound',
        target: `${employeeNo}/${msg.conversationId}`,
        detail: {
          eventId: msg.eventId,
          conversationId: result.conversationId,
          durationMs: result.durationMs,
          replyChars: result.replyText.length,
        },
      });
    } catch (err) {
      const timedOut = turn.signal.aborted && !loop.abort.signal.aborted;
      if (loop.abort.signal.aborted) return;
      loop.errors += 1;
      await this.audit.record({
        actor,
        action: 'message.error',
        target: `${employeeNo}/${msg.conversationId}`,
        detail: {
          eventId: msg.eventId,
          timedOut,
          timeoutMs,
          reason: timedOut ? `agent turn timed out after ${timeoutMs}ms` : (err as Error).message,
        },
      });
      if (timedOut) {
        await loop.channel.send(msg.conversationId, TIMEOUT_NOTICE).catch(() => undefined);
      }
    } finally {
      clearTimeout(timer);
      loop.abort.signal.removeEventListener('abort', onLoopAbort);
    }
  }

  async stop(employeeNo: string, actor: string) {
    const loop = this.loops.get(employeeNo);
    if (!loop) throw new Error(`message loop for employee ${employeeNo} is not running`);
    this.loops.delete(employeeNo);
    // 停机先取消在跑的轮次，等队列落定后再关通道，避免带着未完成的模型调用退出
    loop.abort.abort();
    await Promise.allSettled([...loop.chains.values()]);
    await loop.channel.stop();
    await this.audit.record({
      actor,
      action: 'loop.stop',
      target: employeeNo,
      detail: { processed: loop.processed, errors: loop.errors, dropped: loop.dropped },
    });
    return { employeeNo, running: false };
  }

  status() {
    return [...this.loops.entries()].map(([employeeNo, loop]) => ({
      employeeNo,
      running: true,
      startedAt: loop.startedAt,
      processed: loop.processed,
      errors: loop.errors,
      dropped: loop.dropped,
      queued: loop.queued,
      inflight: loop.inflight,
      lastDiagnostic: loop.lastDiagnostic ?? null,
    }));
  }

  /** core 退出前优雅停机所有闭环（SIGTERM 子进程会由 channel.stop 处理）。 */
  async stopAll(actor: string) {
    for (const employeeNo of [...this.loops.keys()]) {
      await this.stop(employeeNo, actor).catch(() => undefined);
    }
  }
}
