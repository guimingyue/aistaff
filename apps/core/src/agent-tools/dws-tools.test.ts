import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isolatedEnv } from '../connections/dingtalk.adapter';
import { DWS_TOOL_NAMES, createDwsTools } from './dws-tools';

const FAKE_BIN = join(__dirname, '..', 'connections', 'testing', 'fake-dws.mjs');
const PWN_MARKER = join(tmpdir(), 'aistaff-tool-pwned');

interface ToolOutcome {
  content: { text?: string }[];
  details: { exitCode?: number; truncated?: boolean };
}

const USERS = { 'ai-xz-001': '小助', '000001': '张三' };
const DOCS = [
  { nodeId: 'doc-q3', name: '三季度汇报', markdown: '# 三季度\n营收口径见附录 B' },
  { nodeId: 'doc-okr', name: 'OKR 规范', markdown: '# OKR' },
];

function harness(opts: { env?: Record<string, string | undefined>; maxOutputChars?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aistaff-tools-'));
  const argvOut = join(dir, 'argv.ndjson');
  const env = isolatedEnv(dir, {
    FAKE_USERS: JSON.stringify(USERS),
    FAKE_DOCS: JSON.stringify(DOCS),
    FAKE_ARGV_OUT: argvOut,
    ...opts.env,
  });
  const tools = createDwsTools({
    bin: FAKE_BIN,
    env,
    ...(opts.maxOutputChars === undefined ? {} : { maxOutputChars: opts.maxOutputChars }),
  }) as unknown as {
    name: string;
    execute: (id: string, params: unknown) => Promise<ToolOutcome>;
  }[];
  const lastArgv = () => JSON.parse(readFileSync(argvOut, 'utf8').trim().split('\n').at(-1)!) as string[];
  return {
    dir,
    tools,
    lastArgv,
    tool(name: string) {
      const found = tools.find((t) => t.name === name);
      assert.ok(found, `tool ${name} is not registered`);
      return found;
    },
  };
}

describe('数字员工的钉钉 CLI 工具', () => {
  before(() => {
    rmSync(PWN_MARKER, { force: true });
  });
  after(() => {
    rmSync(PWN_MARKER, { force: true });
  });

  it('注册的工具名与对外声明的清单一致', () => {
    const h = harness();
    try {
      assert.deepEqual(h.tools.map((t) => t.name), [...DWS_TOOL_NAMES]);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  describe('只读工具', () => {
    it('通讯录按 --ids= 单 argv 传递，CLI 的 JSON 原样回给模型', async () => {
      const h = harness();
      try {
        const res = await h.tool('dws_contact_user_get').execute('tc1', { userIds: 'ai-xz-001,000001' });
        assert.match(res.content[0].text!, /小助/);
        assert.deepEqual(h.lastArgv(), ['contact', 'user', 'get', '--ids=ai-xz-001,000001', '-f', 'json']);
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
      }
    });

    it('文档检索把自由文本作为 --query= 传递并带上 limit', async () => {
      const h = harness();
      try {
        await h.tool('dws_doc_search').execute('tc1', { query: '三季度 汇报', limit: 3 });
        assert.deepEqual(h.lastArgv(), [
          'drive',
          '+search-docs',
          '--query=三季度 汇报',
          '--limit=3',
          '-f',
          'json',
        ]);
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
      }
    });

    it('limit 缺省为 10，越界或非整数一律拒绝', async () => {
      const h = harness();
      try {
        await h.tool('dws_doc_search').execute('tc1', { query: 'OKR' });
        assert.deepEqual(h.lastArgv(), ['drive', '+search-docs', '--query=OKR', '--limit=10', '-f', 'json']);
        for (const bad of [0, -1, 21, 1.5]) {
          await assert.rejects(
            () => h.tool('dws_doc_search').execute('tc1', { query: 'OKR', limit: bad }),
            /limit/,
            `limit=${bad} 应被拒绝`,
          );
        }
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
      }
    });

    it('读不到的文档按失败上报，而不是返回空内容让模型编造', async () => {
      const h = harness();
      try {
        await assert.rejects(
          () => h.tool('dws_doc_read').execute('tc1', { node: 'doc-nope' }),
          /not found|failed/,
        );
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
      }
    });

    it('超出字符上限时截断并在 details 标记，避免整篇文档挤爆上下文', async () => {
      const h = harness({ maxOutputChars: 20 });
      try {
        const res = await h.tool('dws_doc_read').execute('tc1', { node: 'doc-q3' });
        assert.equal(res.details.truncated, true);
        assert.match(res.content[0].text!, /输出已截断/);
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
      }
    });
  });

  describe('写操作工具', () => {
    it('待办的标题、执行人、截止与优先级原样落到 CLI', async () => {
      const todoOut = join(mkdtempSync(join(tmpdir(), 'aistaff-todo-')), 'todos.ndjson');
      const h = harness({ env: { FAKE_TODO_OUT: todoOut } });
      try {
        await h.tool('dws_todo_create').execute('tc1', {
          title: '补齐三季度营收口径',
          executorUserIds: '000001',
          due: '2026-10-05T18:00:00Z',
          priority: 30,
        });
        const written = JSON.parse(readFileSync(todoOut, 'utf8').trim()) as Record<string, string>;
        assert.deepEqual(written, {
          title: '补齐三季度营收口径',
          executors: '000001',
          due: '2026-10-05T18:00:00Z',
          priority: '30',
        });
        assert.deepEqual(h.lastArgv(), [
          'todo',
          '+create',
          '--title=补齐三季度营收口径',
          '--executors=000001',
          '--due=2026-10-05T18:00:00Z',
          '--priority=30',
          '-f',
          'json',
        ]);
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
        rmSync(join(todoOut, '..'), { recursive: true, force: true });
      }
    });

    it('缺执行人、非 ISO 截止时间、越界优先级都在触达 CLI 前被拒', async () => {
      const h = harness();
      try {
        await assert.rejects(
          () => h.tool('dws_todo_create').execute('tc1', { title: 't', executorUserIds: ' ' }),
          /executorUserIds/,
        );
        await assert.rejects(
          () => h.tool('dws_todo_create').execute('tc1', { title: 't', executorUserIds: '000001', due: '下周三' }),
          /due/,
        );
        await assert.rejects(
          () => h.tool('dws_todo_create').execute('tc1', { title: 't', executorUserIds: '000001', due: '2026-13-45' }),
          /due/,
        );
        await assert.rejects(
          () => h.tool('dws_todo_create').execute('tc1', { title: 't', executorUserIds: '000001', priority: 99 }),
          /priority/,
        );
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
      }
    });
  });

  describe('模型可控文本的注入面', () => {
    const samples = ['x" && touch ' + PWN_MARKER + ' #', '--ids=ai-xz-001', '$(touch ' + PWN_MARKER + ')'];

    it('自由文本与标识符参数都只作为单个 argv 值传给 CLI，不产生 shell 副作用', async () => {
      const h = harness();
      try {
        await h.tool('dws_doc_search').execute('tc1', { query: samples[0] });
        assert.deepEqual(h.lastArgv().slice(0, 3), ['drive', '+search-docs', `--query=${samples[0]}`]);

        await assert.rejects(() => h.tool('dws_contact_user_get').execute('tc1', { userIds: samples[0] }), /userIds/);
        await assert.rejects(() => h.tool('dws_contact_user_get').execute('tc1', { userIds: samples[1] }), /userIds/);
        await h.tool('dws_todo_create').execute('tc1', { title: samples[2], executorUserIds: '000001' });
        assert.deepEqual(h.lastArgv().slice(0, 2), ['todo', '+create']);
        assert.equal(existsSync(PWN_MARKER), false, '出现 shell 注入副作用文件');
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
      }
    });

    it('超过数量或长度上限的入参在触达 CLI 前被拒', async () => {
      const h = harness();
      try {
        await assert.rejects(
          () => h.tool('dws_contact_user_get').execute('tc1', { userIds: Array.from({ length: 21 }, (_, i) => `u${i}`).join(',') }),
          /1-20/,
        );
        await assert.rejects(
          () => h.tool('dws_doc_search').execute('tc1', { query: '' }),
          /query/,
        );
        await assert.rejects(
          () => h.tool('dws_todo_create').execute('tc1', { title: '长'.repeat(201), executorUserIds: '000001' }),
          /title/,
        );
      } finally {
        rmSync(h.dir, { recursive: true, force: true });
      }
    });
  });
});
