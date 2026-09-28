import { Inject, Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AGENT_RUNNER, AgentRunner, AgentStepEvent, RunTurnRequest } from './agent-runner';

export interface ChatResult {
  employeeNo: string;
  conversationId: string;
  replyText: string;
  /** 本轮 Agent 处理过程（工具调用/结果；AISTAFF_SHOW_THINKING=1 时含 thinking） */
  steps: AgentStepEvent[];
  modelUsed?: string;
  durationMs: number;
}

export interface ChatOptions {
  actor: string;
  conversationId?: string;
  channel?: string;
  /** 三方会话标识（如钉钉 openConversationId）：同员工同通道同标识复用同一 Conversation */
  externalConversationId?: string;
  /** 群内发送人标识：同一群里不同成员各自独立上下文，互不串台 */
  senderExternalUserId?: string;
  /** 取消信号：消息回路超时或停机时中止本轮 Agent 运行 */
  signal?: AbortSignal;
}

@Injectable()
export class ChatService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
  ) {}

  private dataDir(): string {
    return process.env.AISTAFF_DATA_DIR ?? resolve(process.cwd(), '..', '..', 'data');
  }

  workspaceDir(employeeNo: string): string {
    return resolve(this.dataDir(), 'workspaces', employeeNo);
  }

  async chat(
    employeeNo: string,
    message: string,
    opts: ChatOptions,
  ): Promise<ChatResult> {
    const startedAt = Date.now();
    const ctx: { conversationId?: string } = {};
    try {
      return await this.chatInner(employeeNo, message, opts, startedAt, ctx);
    } catch (err) {
      await this.audit.record({
        actor: opts.actor,
        action: 'agent.run.reject',
        target: `${employeeNo}/${ctx.conversationId ?? '-'}`,
        detail: {
          runner: this.runner.kind,
          reason: (err as Error).message,
          durationMs: Date.now() - startedAt,
        },
      });
      throw err;
    }
  }

  private async chatInner(
    employeeNo: string,
    message: string,
    opts: ChatOptions,
    startedAt: number,
    ctx: { conversationId?: string },
  ): Promise<ChatResult> {
    const employee = await this.prisma.staff.employee.findUnique({
      where: { employeeNo },
      include: { agentProfile: true },
    });
    if (!employee) throw new Error(`employee ${employeeNo} does not exist`);
    if (employee.status !== 'ACTIVE') {
      throw new Error(`employee ${employeeNo} is ${employee.status}; only ACTIVE employees can chat`);
    }
    const profile = employee.agentProfile;
    if (!profile) throw new Error(`employee ${employeeNo} has no AgentProfile configured`);
    if (profile.status === 'DISABLED') throw new Error(`employee ${employeeNo}: AgentProfile is disabled`);
    if (!message.trim()) throw new Error('message is empty');

    let conversation;
    if (opts.conversationId) {
      conversation = await this.prisma.sessions.conversation.findUnique({
        where: { id: opts.conversationId },
      });
      if (!conversation || conversation.employeeId !== employee.id) {
        throw new Error(`conversation ${opts.conversationId} does not exist or does not belong to employee ${employeeNo}`);
      }
    } else {
      const channel = opts.channel ?? 'CONSOLE';
      const senderId = opts.senderExternalUserId ?? null;
      if (opts.externalConversationId) {
        conversation = await this.prisma.sessions.conversation.findFirst({
          where: {
            employeeId: employee.id,
            channel,
            externalId: opts.externalConversationId,
            externalSenderId: senderId,
          },
        });
      }
      if (!conversation) {
        conversation = await this.prisma.sessions.conversation.create({
          data: {
            employeeId: employee.id,
            channel,
            externalId: opts.externalConversationId,
            externalSenderId: senderId,
          },
        });
      }
    }
    ctx.conversationId = conversation.id;

    const tools = profile.tools ? (JSON.parse(profile.tools) as string[]) : undefined;
    const steps: AgentStepEvent[] = [];
    const turnReq: RunTurnRequest = {
      employeeNo,
      name: employee.name,
      systemPrompt:
        profile.systemPrompt ??
        `你是组织内的数字员工「${employee.name}」（工号 ${employeeNo}），以同事口吻协作，回答简洁。`,
      model: profile.model ?? undefined,
      tools,
      message,
      workspaceDir: this.workspaceDir(employeeNo),
      sessionFile: conversation.agentSessionFile ?? undefined,
      signal: opts.signal,
      onEvent: (ev) => steps.push(ev),
    };
    mkdirSync(turnReq.workspaceDir, { recursive: true });

    await this.prisma.sessions.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
        senderExternalUserId: opts.senderExternalUserId ?? null,
      },
    });

    const result = await this.runner.runTurn(turnReq);
    const durationMs = Date.now() - startedAt;

    await this.prisma.sessions.message.create({
      data: { conversationId: conversation.id, role: 'assistant', content: result.replyText },
    });
    if (result.sessionFile !== conversation.agentSessionFile) {
      await this.prisma.sessions.conversation.update({
        where: { id: conversation.id },
        data: { agentSessionFile: result.sessionFile },
      });
    }

    await this.audit.record({
      actor: opts.actor,
      action: 'agent.run',
      target: `${employeeNo}/${conversation.id}`,
      detail: {
        runner: this.runner.kind,
        model: result.modelUsed ?? profile.model ?? null,
        durationMs,
        userChars: message.length,
        replyChars: result.replyText.length,
        steps: steps.length,
        sessionFile: result.sessionFile,
      },
    });
    return {
      employeeNo,
      conversationId: conversation.id,
      replyText: result.replyText,
      steps,
      modelUsed: result.modelUsed,
      durationMs,
    };
  }

  async conversations(employeeNo: string, messageLimit = 20) {
    const employee = await this.prisma.staff.employee.findUnique({
      where: { employeeNo },
      include: { agentProfile: true },
    });
    if (!employee) throw new Error(`employee ${employeeNo} does not exist`);
    const conversations = await this.prisma.sessions.conversation.findMany({
      where: { employeeId: employee.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { messages: { orderBy: { createdAt: 'asc' }, take: messageLimit } },
    });
    return { employeeNo, agentEnabled: employee.agentProfile?.status === 'ENABLED', conversations };
  }
}
