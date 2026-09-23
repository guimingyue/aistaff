import { Inject, Injectable } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AGENT_RUNNER, AgentRunner, RunTurnRequest } from './agent-runner';

export interface ChatResult {
  employeeNo: string;
  conversationId: string;
  replyText: string;
  modelUsed?: string;
  durationMs: number;
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
    opts: {
      actor: string;
      conversationId?: string;
      channel?: string;
      /** 三方会话标识（如钉钉 openConversationId）：同员工同通道同标识复用同一 Conversation */
      externalConversationId?: string;
    },
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
    opts: {
      actor: string;
      conversationId?: string;
      channel?: string;
      externalConversationId?: string;
    },
    startedAt: number,
    ctx: { conversationId?: string },
  ): Promise<ChatResult> {
    const employee = await this.prisma.staff.employee.findUnique({
      where: { employeeNo },
      include: { agentProfile: true },
    });
    if (!employee) throw new Error(`员工 ${employeeNo} 不存在`);
    if (employee.status !== 'ACTIVE') {
      throw new Error(`员工 ${employeeNo} 状态为 ${employee.status}，仅 ACTIVE 员工可对话`);
    }
    const profile = employee.agentProfile;
    if (!profile) throw new Error(`员工 ${employeeNo} 未配置 AgentProfile，无法对话`);
    if (profile.status === 'DISABLED') throw new Error(`员工 ${employeeNo} 的 AgentProfile 已禁用`);
    if (!message.trim()) throw new Error('消息内容为空');

    let conversation;
    if (opts.conversationId) {
      conversation = await this.prisma.sessions.conversation.findUnique({
        where: { id: opts.conversationId },
      });
      if (!conversation || conversation.employeeId !== employee.id) {
        throw new Error(`会话 ${opts.conversationId} 不存在或不属于员工 ${employeeNo}`);
      }
    } else {
      const channel = opts.channel ?? 'CONSOLE';
      if (opts.externalConversationId) {
        conversation = await this.prisma.sessions.conversation.findFirst({
          where: { employeeId: employee.id, channel, externalId: opts.externalConversationId },
        });
      }
      if (!conversation) {
        conversation = await this.prisma.sessions.conversation.create({
          data: {
            employeeId: employee.id,
            channel,
            externalId: opts.externalConversationId,
          },
        });
      }
    }
    ctx.conversationId = conversation.id;

    const tools = profile.tools ? (JSON.parse(profile.tools) as string[]) : undefined;
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
    };
    mkdirSync(turnReq.workspaceDir, { recursive: true });

    await this.prisma.sessions.message.create({
      data: { conversationId: conversation.id, role: 'user', content: message },
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
        sessionFile: result.sessionFile,
      },
    });
    return {
      employeeNo,
      conversationId: conversation.id,
      replyText: result.replyText,
      modelUsed: result.modelUsed,
      durationMs,
    };
  }

  async conversations(employeeNo: string, messageLimit = 20) {
    const employee = await this.prisma.staff.employee.findUnique({
      where: { employeeNo },
      include: { agentProfile: true },
    });
    if (!employee) throw new Error(`员工 ${employeeNo} 不存在`);
    const conversations = await this.prisma.sessions.conversation.findMany({
      where: { employeeId: employee.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { messages: { orderBy: { createdAt: 'asc' }, take: messageLimit } },
    });
    return { employeeNo, agentEnabled: employee.agentProfile?.status === 'ENABLED', conversations };
  }
}
