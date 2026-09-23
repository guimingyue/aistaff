import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ChatService } from '../agent-runtime/chat.service';
import { InboundMessage, LOOP_PROVIDERS, LoopChannel, LoopProvider } from './channel';

const UNSUPPORTED_NOTICE = '抱歉，我暂时只能处理文本消息，图片/富卡片等类型支持在后续版本开放。';

interface RunningLoop {
  channel: LoopChannel;
  startedAt: string;
  seen: Set<string>;
  queue: Promise<void>;
  processed: number;
  errors: number;
  lastDiagnostic?: string;
}

@Injectable()
export class MessageLoopService {
  private readonly loops = new Map<string, RunningLoop>();

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
    if (this.loops.has(employeeNo)) throw new Error(`员工 ${employeeNo} 的消息闭环已在运行`);
    const employee = await this.prisma.staff.employee.findUnique({
      where: { employeeNo },
      include: { bindings: true, agentProfile: true },
    });
    if (!employee) throw new Error(`员工 ${employeeNo} 不存在`);
    if (employee.status !== 'ACTIVE') throw new Error(`员工 ${employeeNo} 状态为 ${employee.status}，仅 ACTIVE 可上线`);
    if (employee.agentProfile?.status !== 'ENABLED') throw new Error(`员工 ${employeeNo} 无启用的 AgentProfile`);
    const binding = employee.bindings.find((b) => b.provider === 'DINGTALK');
    if (binding?.bindingStatus !== 'BOUND') {
      throw new Error(`员工 ${employeeNo} 的 DINGTALK 绑定未 BOUND，先完成绑定校验`);
    }
    const provider = this.providers.DINGTALK;
    if (!provider) throw new Error('DINGTALK 闭环通道未配置');
    const dir = this.profileDir(employeeNo);
    if (!(await provider.authStatus(dir))) {
      throw new Error(`员工 ${employeeNo} 的钉钉 CLI profile 未登录，先执行 aistaff login ${employeeNo}`);
    }

    const loop: RunningLoop = {
      channel: provider.channel(dir),
      startedAt: new Date().toISOString(),
      seen: new Set(),
      queue: Promise.resolve(),
      processed: 0,
      errors: 0,
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
          detail: { code, processed: loop.processed, errors: loop.errors, lastDiagnostic: loop.lastDiagnostic },
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
    if (loop.seen.has(msg.eventId)) return;
    if (loop.seen.size > 5000) loop.seen.clear();
    loop.seen.add(msg.eventId);
    loop.queue = loop.queue.then(() => this.handle(employeeNo, loop, msg).catch(() => undefined));
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
      loop.errors += 1;
      await this.audit.record({
        actor,
        action: 'message.error',
        target: `${employeeNo}/${msg.conversationId}`,
        detail: { eventId: msg.eventId, reason: (err as Error).message },
      });
    }
  }

  async stop(employeeNo: string, actor: string) {
    const loop = this.loops.get(employeeNo);
    if (!loop) throw new Error(`员工 ${employeeNo} 的消息闭环未在运行`);
    this.loops.delete(employeeNo);
    await loop.channel.stop();
    await this.audit.record({
      actor,
      action: 'loop.stop',
      target: employeeNo,
      detail: { processed: loop.processed, errors: loop.errors },
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
