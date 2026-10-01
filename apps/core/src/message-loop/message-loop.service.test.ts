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
import { InboundMedia, InboundMessage, LoopChannel, LoopProvider } from './channel';
import type { EmployeeConfig } from '../config/employee-config.schema';

class FakeChannel implements LoopChannel {
  handlers?: { onMessage(m: InboundMessage): void; onDiagnostic(l: string): void; onExit(c: number | null): void };
  readonly sent: Array<{ to: string; text: string }> = [];
  readonly mediaCalls: Array<{ messageId: string; workspaceDir: string }> = [];
  sendFail = false;
  stopped = 0;
  mediaResult: InboundMedia = { images: [], discoveredCount: 0, skippedCount: 0 };
  mediaFail: Error | undefined;

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
  async fetchImages(messageId: string, workspaceDir: string): Promise<InboundMedia> {
    this.mediaCalls.push({ messageId, workspaceDir });
    if (this.mediaFail) throw this.mediaFail;
    return this.mediaResult;
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
  delayMs = 0;
  concurrent = 0;
  maxConcurrent = 0;

  async runTurn(req: RunTurnRequest): Promise<RunTurnResult> {
    this.requests.push(req);
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      if (this.failNext) {
        const err = this.failNext;
        this.failNext = undefined;
        throw err;
      }
      if (this.delayMs > 0) {
        const delay = this.delayMs;
        await new Promise<void>((resolveDelay, rejectDelay) => {
          const timer = setTimeout(resolveDelay, delay);
          req.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              rejectDelay(new Error('aborted by signal'));
            },
            { once: true },
          );
        });
      }
      return { replyText: `答：${req.message}`, sessionFile: join(req.workspaceDir, 'loop-session.jsonl') };
    } finally {
      this.concurrent -= 1;
    }
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
    await assert.rejects(() => loops.start('AI000001', 'tester'), /not logged in/);
    assert.deepEqual(loops.status(), []);
    authed = true;
  });

  it('前置校验：绑定非 BOUND 拒绝', async () => {
    const a1 = await staffPrisma.employee.findUniqueOrThrow({ where: { employeeNo: 'AI000001' } });
    await staffPrisma.externalBinding.update({
      where: { employeeId_provider: { employeeId: a1.id, provider: 'DINGTALK' } },
      data: { bindingStatus: 'PENDING' },
    });
    await assert.rejects(() => loops.start('AI000001', 'tester'), /not BOUND/);
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

  it('同群不同发送人：各自独立会话，上下文不串台', async () => {
    const runsBefore = runner.requests.length;
    const sentBefore = channel.sent.length;
    channel.emit(
      ev({
        eventId: 'evt-sender-b',
        senderName: '丙弟',
        senderOpenDingTalkId: 'open-bd',
        content: '我刚才问了什么？',
      }),
    );
    await waitFor(() => runner.requests.length === runsBefore + 1);
    await waitFor(() => channel.sent.length === sentBefore + 1);

    assert.equal(runner.requests.at(-1)!.sessionFile, undefined, '新发送人首轮必须开新 Agent 会话');
    assert.equal(channel.sent.at(-1)!.to, 'cid-group-a', '回发目标仍是原群');

    const a1 = await staffPrisma.employee.findUniqueOrThrow({ where: { employeeNo: 'AI000001' } });
    const convs = await sessionsPrisma.conversation.findMany({
      where: { employeeId: a1.id, channel: 'DINGTALK' },
      orderBy: { createdAt: 'asc' },
    });
    assert.deepEqual(convs.map((c) => c.externalSenderId), ['open-yj', 'open-bd']);
    assert.equal(convs.every((c) => c.externalId === 'cid-group-a'), true);
    const userMsgs = await sessionsPrisma.message.findMany({
      where: { conversationId: convs[1].id, role: 'user' },
    });
    assert.equal(userMsgs[0].senderExternalUserId, 'open-bd');
  });

  it('eventId 去重：同一事件重复投递只处理一次', async () => {
    const sentBefore = channel.sent.length;
    channel.emit(ev({ eventId: 'evt-dup' }));
    channel.emit(ev({ eventId: 'evt-dup' }));
    await waitFor(() => channel.sent.length === sentBefore + 1);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(channel.sent.length, sentBefore + 1, '重复事件不得二次回发');
  });

  it('非文本消息：降级为暂不支持提示，不触发 Agent', async () => {
    const runsBefore = runner.requests.length;
    const sentBefore = channel.sent.length;
    channel.emit(ev({ eventId: 'evt-non-text', content: '' }));
    await waitFor(() => channel.sent.length === sentBefore + 1);
    assert.match(channel.sent.at(-1)!.text, /没有我能处理的内容/);
    assert.equal(runner.requests.length, runsBefore);
    assert.equal(channel.mediaCalls.length, 0, '无 messageId 时不得凭空探测资源');
  });

  it('纯文本不探测资源：不多花一次 CLI 往返', async () => {
    const callsBefore = channel.mediaCalls.length;
    const runsBefore = runner.requests.length;
    channel.emit(ev({ eventId: 'evt-text-no-media', messageId: 'msg-plain', content: '这个链接 https://a.com/x?file=1 看下' }));
    await waitFor(() => runner.requests.length === runsBefore + 1);
    assert.equal(channel.mediaCalls.length, callsBefore, '正文没有资源标记就不该调用取图');
    assert.equal(runner.requests.at(-1)!.images, undefined);
  });

  it('正文带 mediaId 标记：取图后连同原文交给 Agent，并记 message.media 审计', async () => {
    channel.mediaResult = {
      images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
      discoveredCount: 1,
      skippedCount: 0,
    };
    const runsBefore = runner.requests.length;
    channel.emit(
      ev({
        eventId: 'evt-img-with-text',
        messageId: 'msg-att-1',
        content: '这张图里的报错是什么意思？\n[图片] mediaId:med-1',
      }),
    );
    await waitFor(() => runner.requests.length === runsBefore + 1);
    const req = runner.requests.at(-1)!;
    assert.deepEqual(req.images, [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
    assert.match(req.message, /这张图里的报错是什么意思？/);
    assert.equal(channel.mediaCalls.at(-1)!.messageId, 'msg-att-1');
    assert.ok(channel.mediaCalls.at(-1)!.workspaceDir.endsWith(join('workspaces', 'AI000001')));
    const mediaAudit = audits.find((a) => a.action === 'message.media');
    assert.ok(mediaAudit, '缺资源审计');
    assert.match(JSON.stringify(mediaAudit!.detail), /"images":1/);
  });

  it('只发图片没有文字：带图进 Agent，问题文本给出图片说明', async () => {
    channel.mediaResult = {
      images: [{ data: 'SU1H', mimeType: 'image/png' }],
      discoveredCount: 1,
      skippedCount: 0,
    };
    const runsBefore = runner.requests.length;
    channel.emit(ev({ eventId: 'evt-img-only', messageId: 'msg-att-2', content: '' }));
    await waitFor(() => runner.requests.length === runsBefore + 1);
    assert.equal(runner.requests.at(-1)!.message, '（发来 1 张图片）');
    assert.equal(runner.requests.at(-1)!.images?.length, 1);
    assert.equal(channel.sent.at(-1)!.text, '答：（发来 1 张图片）');
  });

  it('超上限的附件：问题里显式说明有几个没读到，员工不会以为图都看完了', async () => {
    channel.mediaResult = {
      images: [{ data: 'SU1H', mimeType: 'image/png' }],
      discoveredCount: 3,
      skippedCount: 2,
    };
    const runsBefore = runner.requests.length;
    channel.emit(ev({ eventId: 'evt-img-partial', messageId: 'msg-att-3', content: '' }));
    await waitFor(() => runner.requests.length === runsBefore + 1);
    assert.match(runner.requests.at(-1)!.message, /另有 2 个附件没能读取/);
  });

  it('只有视频/文件资源：回媒体专用降级文案且不触发 Agent', async () => {
    channel.mediaResult = { images: [], discoveredCount: 1, skippedCount: 1 };
    const runsBefore = runner.requests.length;
    const sentBefore = channel.sent.length;
    channel.emit(ev({ eventId: 'evt-video-only', messageId: 'msg-att-4', content: '' }));
    await waitFor(() => channel.sent.length === sentBefore + 1);
    assert.match(channel.sent.at(-1)!.text, /视频、语音和文件/);
    assert.equal(runner.requests.length, runsBefore);
    assert.ok(audits.some((a) => JSON.stringify(a.detail)?.includes('unsupported-media')));
  });

  it('带文字的视频消息：不空转降级，正文照答并显式告知有附件没读到', async () => {
    channel.mediaResult = { images: [], discoveredCount: 1, skippedCount: 1 };
    const runsBefore = runner.requests.length;
    channel.emit(
      ev({
        eventId: 'evt-video-with-text',
        messageId: 'msg-att-6',
        content: '这个会议视频讲了什么重点？\nmediaId:med-10',
      }),
    );
    await waitFor(() => runner.requests.length === runsBefore + 1);
    assert.match(runner.requests.at(-1)!.message, /这个会议视频讲了什么重点？/);
    assert.match(runner.requests.at(-1)!.message, /另有 1 个附件没能读取/);
    assert.equal(runner.requests.at(-1)!.images, undefined);
  });

  it('取图失败不阻断回复：有正文就照正文回答，并记 message.media.error', async () => {
    channel.mediaFail = new Error('资源下载超时');
    const runsBefore = runner.requests.length;
    channel.emit(ev({ eventId: 'evt-media-fail', messageId: 'msg-att-5', content: '图没发出去，先看文字：mediaId:med-8' }));
    await waitFor(() => runner.requests.length === runsBefore + 1);
    assert.equal(runner.requests.at(-1)!.images, undefined);
    assert.ok(audits.some((a) => a.action === 'message.media.error' && JSON.stringify(a.detail)?.includes('资源下载超时')));
    channel.mediaFail = undefined;
    channel.mediaResult = { images: [], discoveredCount: 0, skippedCount: 0 };
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

  it('单轮超时：中止 Agent、记 message.error(timedOut) 并回发提示，闭环存活', async () => {
    process.env.AISTAFF_LOOP_TURN_TIMEOUT_MS = '60';
    runner.delayMs = 5000;
    const sentBefore = channel.sent.length;
    channel.emit(ev({ eventId: 'evt-timeout', senderName: '慢郎', senderOpenDingTalkId: 'open-slow' }));

    await waitFor(() =>
      audits.some((a) => a.action === 'message.error' && JSON.stringify(a.detail)?.includes('timed out')),
    );
    const timeoutAudit = audits.find(
      (a) => a.action === 'message.error' && JSON.stringify(a.detail)?.includes('timed out'),
    )!;
    assert.equal((timeoutAudit.detail as { timedOut: boolean }).timedOut, true);
    assert.equal(runner.requests.at(-1)!.signal?.aborted, true, '取消信号必须传到 Agent 运行');

    await waitFor(() => channel.sent.length === sentBefore + 1);
    assert.match(channel.sent.at(-1)!.text, /超时/);
    assert.equal(loops.status().length, 1, '超时不得让闭环退出');

    runner.delayMs = 0;
    delete process.env.AISTAFF_LOOP_TURN_TIMEOUT_MS;
  });

  it('并发闸门：MAX_CONCURRENT=1 全局串行，放宽后不同发送人可并行', async () => {
    runner.delayMs = 60;

    process.env.AISTAFF_LOOP_MAX_CONCURRENT = '1';
    runner.maxConcurrent = 0;
    let sentBefore = channel.sent.length;
    for (const id of ['s1', 's2', 's3']) {
      channel.emit(ev({ eventId: `evt-ser-${id}`, senderName: `同事${id}`, senderOpenDingTalkId: `open-${id}`, content: `串行${id}` }));
    }
    await waitFor(() => channel.sent.length === sentBefore + 3, 8000);
    assert.equal(runner.maxConcurrent, 1, '并发上限为 1 时必须全局串行');

    process.env.AISTAFF_LOOP_MAX_CONCURRENT = '3';
    runner.maxConcurrent = 0;
    sentBefore = channel.sent.length;
    for (const id of ['p1', 'p2', 'p3']) {
      channel.emit(ev({ eventId: `evt-par-${id}`, senderName: `同事${id}`, senderOpenDingTalkId: `open-${id}`, content: `并行${id}` }));
    }
    await waitFor(() => channel.sent.length === sentBefore + 3, 8000);
    assert.ok(runner.maxConcurrent > 1, `放宽上限后应可并行，实际 maxConcurrent=${runner.maxConcurrent}`);

    runner.delayMs = 0;
    delete process.env.AISTAFF_LOOP_MAX_CONCURRENT;
  });

  it('队列上限：积压超限的消息被丢弃、记 message.dropped 并回发提示', async () => {
    process.env.AISTAFF_LOOP_MAX_QUEUED = '2';
    process.env.AISTAFF_LOOP_MAX_CONCURRENT = '1';
    runner.delayMs = 200;
    const sentBefore = channel.sent.length;
    for (const n of [1, 2, 3, 4]) {
      channel.emit(
        ev({ eventId: `evt-q-${n}`, senderName: '排队君', senderOpenDingTalkId: 'open-q', content: `第${n}条` }),
      );
    }
    await waitFor(() => audits.filter((a) => a.action === 'message.dropped').length === 2);
    const dropped = audits.filter((a) => a.action === 'message.dropped');
    assert.match(JSON.stringify(dropped[0].detail), /loop queue full/);
    await waitFor(() => channel.sent.filter((s) => s.text.includes('积压较多')).length === 2);

    runner.delayMs = 0;
    // 已受理的两条仍要正常回发，丢弃不得影响在跑的队列
    await waitFor(() => channel.sent.length >= sentBefore + 4, 8000);
    assert.ok(channel.sent.some((s) => s.text === '答：第1条'));
    assert.ok(channel.sent.some((s) => s.text === '答：第2条'));
    assert.equal(loops.status()[0].dropped, 2);

    delete process.env.AISTAFF_LOOP_MAX_QUEUED;
    delete process.env.AISTAFF_LOOP_MAX_CONCURRENT;
  });

  it('stop：优雅停机 + loop.stop 审计 + 状态清空；重复 start 拒绝', async () => {
    await loops.stop('AI000001', 'tester');
    assert.equal(channel.stopped, 1);
    assert.deepEqual(loops.status(), []);
    assert.ok(audits.some((a) => a.action === 'loop.stop' && a.target === 'AI000001'));
    await assert.rejects(() => loops.stop('AI000001', 'tester'), /is not running/);

    await loops.start('AI000001', 'tester');
    await assert.rejects(() => loops.start('AI000001', 'tester'), /already running/);
    await loops.stop('AI000001', 'tester');
  });
});
