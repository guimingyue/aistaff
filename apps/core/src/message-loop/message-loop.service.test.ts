import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PrismaClient as StaffPrismaClient } from '../generated/staff';
import { PrismaClient as SessionsPrismaClient } from '../generated/sessions';
import { StaffService } from '../staff/staff.service';
import { ChatService } from '../agent-runtime/chat.service';
import { AgentRunner, RunTurnRequest, RunTurnResult } from '../agent-runtime/agent-runner';
import { MessageLoopService } from './message-loop.service';
import { InboundMessage, LoopChannel, LoopProvider } from './channel';
import type { EmployeeConfig } from '../config/employee-config.schema';

class FakeChannel implements LoopChannel {
  handlers?: { onMessage(m: InboundMessage): void; onDiagnostic(l: string): void; onExit(c: number | null): void };
  readonly sent: Array<{ to: string; text: string }> = [];
  sendFail = false;
  stopped = 0;

  async start(
    handlers: {
      onMessage(m: InboundMessage): void;
      onDiagnostic(l: string): void;
      onExit(c: number | null): void;
    },
  ) {
    this.handlers = handlers;
  }
  async send(to: string, text: string) {
    if (this.sendFail) throw new Error(`回发失败到 ${to}`);
    this.sent.push({ to, text });
  }
  async stop() {
    this.stopped += 1;
    this.handlers?.onExit(0);
  }
  emit(msg: InboundMessage) {
    this.handlers?.onMessage(msg);
  }
}

class ReplyRunner implements AgentRunner {
  readonly kind = 'fake';
  readonly requests: RunTurnRequest[] = [];
  failNext: Error | undefined;
  async runTurn(req: RunTurnRequest): Promise<RunTurnResult> {
    this.requests.push(req);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    return { replyText: `答：${req.message}`, sessionFile: join(req.workspaceDir, 'loop-session.jsonl') };
  }
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(cond(), '等待条件超时');
};

describe('message-loop @消息闭环（假通道+假Runner + 真实 SQLite 双库）', () => {
  let dir: string;
  let staffPrisma: StaffPrismaClient;
  let sessionsPrisma: SessionsPrismaClient;
  let staff: StaffService;
  let loops: MessageLoopService;
  let channel: FakeChannel;
  let runner: ReplyRunner;
  let audits: Array<{ actor: string; action: string; target: string; detail: unknown }> = [];
  let authed = false;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aistaff-m5-'));
    process.env.AISTAFF_DATA_DIR = join(dir, 'data');
    const coreDir = join(__dirname, '..', '..');
    const staffUrl = `file:${join(dir, 'staff.db')}`;
    const sessionsUrl = `file:${join(dir, 'sessions.db')}`;
    for (const [schema, envName, url] of [
      ['prisma/staff.prisma', 'AISTAFF_STAFF_DATABASE_URL', staffUrl],
      ['prisma/sessions.prisma', 'AISTAFF_SESSIONS_DATABASE_URL', sessionsUrl],
    ] as const) {
      execFileSync('npx', ['prisma', 'db', 'push', '--schema', schema, '--skip-generate'], {
        cwd: coreDir,
        env: { ...process.env, [envName]: url },
        stdio: 'pipe',
      });
    }
    staffPrisma = new StaffPrismaClient({ datasourceUrl: staffUrl });
    sessionsPrisma = new SessionsPrismaClient({ datasourceUrl: sessionsUrl });
    staff = new StaffService({ staff: staffPrisma } as never);
    audits = [];
    channel = new FakeChannel();
    runner = new ReplyRunner();
    const auditLike = {
      record: async (e: { actor: string; action: string; target: string; detail: unknown }) => {
        audits.push(e);
      },
    } as never;
    const chat = new ChatService(
      { staff: staffPrisma, sessions: sessionsPrisma } as never,
      auditLike,
      runner as unknown as AgentRunner,
    );
    const providers: Record<'DINGTALK', LoopProvider> = {
      DINGTALK: {
        authStatus: async () => authed,
        channel: () => channel,
      },
    };
    loops = new MessageLoopService(
      { staff: staffPrisma, sessions: sessionsPrisma } as never,
      auditLike,
      chat,
      providers as never,
    );

    await staff.syncFromConfigs(
      new Map<string, EmployeeConfig>([
        ['g1', { name: '甲哥', type: 'HUMAN' } as EmployeeConfig],
        [
          'a1',
          {
            name: '小助',
            type: 'DIGITAL',
            guardian: 'g1',
            agentProfile: { systemPrompt: '人格X' },
          } as EmployeeConfig,
        ],
      ]),
    );
    const a1 = await staffPrisma.employee.findUniqueOrThrow({ where: { employeeNo: 'AI000001' } });
    await staffPrisma.externalBinding.upsert({
      where: { employeeId_provider: { employeeId: a1.id, provider: 'DINGTALK' } },
      create: {
        employeeId: a1.id,
        provider: 'DINGTALK',
        externalUserId: 'ai-xz-001',
        bindingStatus: 'BOUND',
        cliProfileDir: join(dir, 'data', 'cli-profiles', 'AI000001-DINGTALK'),
      },
      update: { bindingStatus: 'BOUND' },
    });
    authed = true;
  });

  after(async () => {
    await loops.stopAll('tester').catch(() => undefined);
    await staffPrisma.$disconnect();
    await sessionsPrisma.$disconnect();
    delete process.env.AISTAFF_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const ev = (over: Partial<InboundMessage>): InboundMessage => ({
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    conversationId: 'cid-group-a',
    senderName: '乙姐',
    senderOpenDingTalkId: 'open-yj',
    content: '帮我查下周三的会',
    ...over,
  });

  it('前置校验：未登录拒绝启动且不留运行态', async () => {
    authed = false;
    await assert.rejects(() => loops.start('AI000001', 'tester'), /未登录/);
    assert.deepEqual(loops.status(), []);
    authed = true;
  });

  it('前置校验：绑定非 BOUND 拒绝', async () => {
    const a1 = await staffPrisma.employee.findUniqueOrThrow({ where: { employeeNo: 'AI000001' } });
    await staffPrisma.externalBinding.update({
      where: { employeeId_provider: { employeeId: a1.id, provider: 'DINGTALK' } },
      data: { bindingStatus: 'PENDING' },
    });
    await assert.rejects(() => loops.start('AI000001', 'tester'), /未 BOUND/);
    await staffPrisma.externalBinding.update({
      where: { employeeId_provider: { employeeId: a1.id, provider: 'DINGTALK' } },
      data: { bindingStatus: 'BOUND' },
    });
  });

  it('Golden Path：@消息→路由 Agent→员工身份回发→全链路审计', async () => {
    const r = await loops.start('AI000001', 'tester');
    assert.equal(r.running, true);
    assert.equal(loops.status()[0].employeeNo, 'AI000001');

    channel.emit(ev({ eventId: 'evt-golden-1' }));
    await waitFor(() => channel.sent.length === 1);
    assert.equal(channel.sent[0].to, 'cid-group-a');
    assert.equal(channel.sent[0].text, '答：帮我查下周三的会');

    const a1 = await staffPrisma.employee.findUniqueOrThrow({ where: { employeeNo: 'AI000001' } });
    const conv = await sessionsPrisma.conversation.findFirstOrThrow({
      where: { employeeId: a1.id, channel: 'DINGTALK' },
    });
    assert.equal(conv.externalId, 'cid-group-a');
    const msgs = await sessionsPrisma.message.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    });
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);

    const chain = audits.filter((a) => a.target.startsWith('AI000001/')).map((a) => a.action);
    assert.ok(chain.includes('message.inbound'), '缺入站审计');
    assert.ok(chain.includes('agent.run'), '缺运行审计');
    assert.ok(chain.includes('message.outbound'), '缺出站审计');
    const inbound = audits.find((a) => a.action === 'message.inbound')!;
    assert.equal(inbound.actor, 'dingtalk:open-yj');
    assert.match(JSON.stringify(inbound.detail), /帮我查下周三的会/);
  });

  it('同群再提问：复用同一 DINGTALK 会话延续上下文', async () => {
    const before = runner.requests.at(-1);
    channel.emit(ev({ eventId: 'evt-golden-2', content: '补充：下午的' }));
    await waitFor(() => channel.sent.length === 2);
    const req = runner.requests.at(-1)!;
    assert.notEqual(req, before);
    assert.ok(req.sessionFile?.includes('loop-session.jsonl'));
    const a1 = await staffPrisma.employee.findUniqueOrThrow({ where: { employeeNo: 'AI000001' } });
    assert.equal(
      await sessionsPrisma.conversation.count({ where: { employeeId: a1.id, channel: 'DINGTALK' } }),
      1,
    );
  });

  it('eventId 去重：同一事件重复投递只处理一次', async () => {
    const sentBefore = channel.sent.length;
    channel.emit(ev({ eventId: 'evt-dup' }));
    channel.emit(ev({ eventId: 'evt-dup' }));
    await waitFor(() => channel.sent.length === sentBefore + 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(channel.sent.length, sentBefore + 1, '重复事件不得二次回发');
  });

  it('非文本消息：一期降级为暂不支持提示，不触发 Agent', async () => {
    const runsBefore = runner.requests.length;
    channel.emit(ev({ eventId: 'evt-non-text', content: '' }));
    await waitFor(() => channel.sent.length === 4);
    assert.match(channel.sent.at(-1)!.text, /暂不支持|只能处理文本/);
    assert.equal(runner.requests.length, runsBefore);
  });

  it('Agent 或回发失败：记 message.error 审计且闭环存活', async () => {
    runner.failNext = new Error('模型不可用');
    channel.emit(ev({ eventId: 'evt-fail-agent' }));
    await waitFor(() => audits.some((a) => a.action === 'message.error' && JSON.stringify(a.detail)?.includes('模型不可用')));
    assert.equal(loops.status().length, 1);

    channel.sendFail = true;
    channel.emit(ev({ eventId: 'evt-fail-send' }));
    await waitFor(() =>
      audits.some((a) => a.action === 'message.error' && JSON.stringify(a.detail)?.includes('回发失败')),
    );
    channel.sendFail = false;
    assert.equal(loops.status().length, 1, '失败不得让闭环退出');
  });

  it('stop：优雅停机 + loop.stop 审计 + 状态清空；重复 start 拒绝', async () => {
    await loops.stop('AI000001', 'tester');
    assert.equal(channel.stopped, 1);
    assert.deepEqual(loops.status(), []);
    assert.ok(audits.some((a) => a.action === 'loop.stop' && a.target === 'AI000001'));
    await assert.rejects(() => loops.stop('AI000001', 'tester'), /未在运行/);

    await loops.start('AI000001', 'tester');
    await assert.rejects(() => loops.start('AI000001', 'tester'), /已在运行/);
    await loops.stop('AI000001', 'tester');
  });
});
