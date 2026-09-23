import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PrismaClient as StaffPrismaClient } from '../generated/staff';
import { PrismaClient as SessionsPrismaClient } from '../generated/sessions';
import { ChatService } from './chat.service';
import { AgentRunner, RunTurnRequest, RunTurnResult } from './agent-runner';
import { StaffService } from '../staff/staff.service';
import type { EmployeeConfig } from '../config/employee-config.schema';

class FakeRunner implements AgentRunner {
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
    return {
      replyText: `回：${req.message}`,
      sessionFile: req.sessionFile ?? join(req.workspaceDir, `session-${this.requests.length}.jsonl`),
      modelUsed: req.model,
    };
  }
}

describe('agent-runtime 员工对话（假 Runner + 真实 SQLite 双库）', () => {
  let dir: string;
  let staffPrisma: StaffPrismaClient;
  let sessionsPrisma: SessionsPrismaClient;
  let staff: StaffService;
  let chat: ChatService;
  let runner: FakeRunner;
  let audits: Array<{ action: string; target: string; detail: unknown }> = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aistaff-m4-'));
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
    runner = new FakeRunner();
    const auditLike = {
      record: async (e: { action: string; target: string; detail: unknown }) => {
        audits.push(e);
      },
    } as never;
    chat = new ChatService(
      { staff: staffPrisma, sessions: sessionsPrisma } as never,
      auditLike,
      runner as unknown as AgentRunner,
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
            agentProfile: {
              systemPrompt: '人格X：简洁协作',
              model: 'anthropic/claude-sonnet-4-5',
              tools: ['read'],
            },
          } as EmployeeConfig,
        ],
        ['g2', { name: '乙姐', type: 'HUMAN' } as EmployeeConfig],
        [
          'a2',
          { name: '机数', type: 'DIGITAL', guardian: 'g1', agentProfile: { systemPrompt: '会坏' } } as EmployeeConfig,
        ],
        ['a3', { name: '默认人格', type: 'DIGITAL', guardian: 'g1', agentProfile: {} } as EmployeeConfig],
      ]),
    );
  });

  after(async () => {
    await staffPrisma.$disconnect();
    await sessionsPrisma.$disconnect();
    delete process.env.AISTAFF_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const messagesOf = (conversationId: string) =>
    sessionsPrisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } });

  it('数字员工对话成功：人格/模型/工具装配 + 会话消息落库 + 审计', async () => {
    const r = await chat.chat('AI000001', '你好', { actor: 'tester' });
    assert.equal(r.employeeNo, 'AI000001');
    assert.equal(r.replyText, '回：你好');

    const req = runner.requests.at(-1)!;
    assert.equal(req.systemPrompt, '人格X：简洁协作');
    assert.equal(req.model, 'anthropic/claude-sonnet-4-5');
    assert.deepEqual(req.tools, ['read']);
    assert.equal(req.name, '小助');
    assert.ok(req.workspaceDir.endsWith(join('workspaces', 'AI000001')));
    assert.equal(req.sessionFile, undefined);

    const conv = await sessionsPrisma.conversation.findUnique({ where: { id: r.conversationId } });
    assert.equal(conv!.channel, 'CONSOLE');
    assert.ok(conv!.agentSessionFile);
    const msgs = await messagesOf(r.conversationId);
    assert.deepEqual(
      msgs.map((m) => [m.role, m.content]),
      [
        ['user', '你好'],
        ['assistant', '回：你好'],
      ],
    );
    assert.ok(audits.some((a) => a.action === 'agent.run' && a.target === `AI000001/${r.conversationId}`));
  });

  it('续会话：conversationId 复用时携带上轮 sessionFile 延续上下文', async () => {
    const emp = await staffPrisma.employee.findUniqueOrThrow({ where: { employeeNo: 'AI000001' } });
    const firstConv = await sessionsPrisma.conversation.findFirstOrThrow({ where: { employeeId: emp.id } });
    const r = await chat.chat('AI000001', '继续', {
      actor: 'tester',
      conversationId: firstConv!.id,
    });
    assert.equal(r.conversationId, firstConv!.id);
    const req = runner.requests.at(-1)!;
    assert.equal(req.sessionFile, firstConv!.agentSessionFile);
    assert.ok(req.sessionFile);
    assert.equal((await messagesOf(firstConv!.id)).length, 4);
  });

  it('缺省人格与工具：AgentProfile 无 systemPrompt 时用平台缺省人格，tools 未声明为 undefined', async () => {
    await chat.chat('AI000003', '在吗', { actor: 'tester' });
    const req = runner.requests.at(-1)!;
    assert.match(req.systemPrompt, /数字员工「默认人格」（工号 AI000003）/);
    assert.equal(req.tools, undefined);
    assert.equal(req.model, undefined);
  });

  it('真人无 AgentProfile：拒绝且无任何会话落库，留 reject 审计', async () => {
    await assert.rejects(() => chat.chat('000001', '自言自语', { actor: 'tester' }), /未配置 AgentProfile/);
    const g1 = await staffPrisma.employee.findUniqueOrThrow({ where: { employeeNo: '000001' } });
    assert.equal(await sessionsPrisma.conversation.count({ where: { employeeId: g1.id } }), 0);
    assert.ok(audits.some((a) => a.action === 'agent.run.reject' && a.target === '000001/-'));
  });

  it('非 ACTIVE 员工拒绝对话', async () => {
    await staff.changeStatus('AI000002', 'SUSPENDED');
    await assert.rejects(() => chat.chat('AI000002', '在吗', { actor: 'tester' }), /SUSPENDED/);
    await staff.changeStatus('AI000002', 'ACTIVE');
  });

  it('AgentProfile 禁用拒绝对话', async () => {
    const emp = await staffPrisma.employee.findUnique({ where: { employeeNo: 'AI000002' } });
    await staffPrisma.agentProfile.update({ where: { employeeId: emp!.id }, data: { status: 'DISABLED' } });
    await assert.rejects(() => chat.chat('AI000002', '在吗', { actor: 'tester' }), /已禁用/);
    await staffPrisma.agentProfile.update({ where: { employeeId: emp!.id }, data: { status: 'ENABLED' } });
  });

  it('会话归属校验：不得借用他人会话', async () => {
    const conv = await sessionsPrisma.conversation.findFirstOrThrow();
    const other = await chat.chat('AI000003', '新话题', { actor: 'tester' });
    await assert.rejects(
      () => chat.chat('AI000002', '串台', { actor: 'tester', conversationId: conv.id }),
      /不存在或不属于/,
    );
    assert.notEqual(conv.id, other.conversationId);
  });

  it('runner 失败：用户消息留档、reject 审计含原因', async () => {
    runner.failNext = new Error('模型爆炸');
    const before_ = audits.length;
    await assert.rejects(() => chat.chat('AI000002', '触发故障', { actor: 'tester' }), /模型爆炸/);
    const reject = audits.slice(before_).find((a) => a.action === 'agent.run.reject');
    assert.ok(reject);
    assert.match(reject!.target, /^AI000002\/[a-z0-9]+$/i);
    assert.match(JSON.stringify(reject!.detail), /模型爆炸/);
  });
});
