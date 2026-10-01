#!/usr/bin/env node
// 测试/E2E 验证用假 CLI：契约与 dws 对齐（auth status/login、contact user get、
// chat message send、chat +messages-mget 资源台账、doc/drive/todo 桩、event consume）。
// 行为优先由 FAKE_* 环境变量驱动（单测注入），
// 环境变量缺省时回落到 profile 目录状态文件（DWS_CONFIG_DIR 下 fake-auth /
// fake-users.json / inbox.ndjson / sent.ndjson），使跨进程验证脚本可用同一
// 隔离 profile 布置与观测。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [sub, ...rest] = process.argv.slice(2);
// 与真实 dws（cobra）对齐：同时接受 `--flag value` 与 `--flag=value`
const flag = (name) => {
  const eq = rest.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const cfg = process.env.DWS_CONFIG_DIR;
const statePath = (name) => {
  if (!cfg) throw new Error('fake-dws: state-file mode requires DWS_CONFIG_DIR');
  mkdirSync(cfg, { recursive: true });
  return join(cfg, name);
};

if (process.env.FAKE_ARGV_OUT) {
  appendFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(process.argv.slice(2)) + '\n');
}
if (process.env.FAKE_ENV_OUT) {
  writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({
    HOME: process.env.HOME,
    DWS_CONFIG_DIR: process.env.DWS_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  }));
}

const out = (obj) => {
  console.log(JSON.stringify(obj));
  process.exit(0);
};

// 文档桩：FAKE_DOCS 优先（单测注入），否则读 profile 目录下的 fake-docs.json
function readFakeDocs() {
  if (process.env.FAKE_DOCS) return JSON.parse(process.env.FAKE_DOCS);
  if (cfg && existsSync(join(cfg, 'fake-docs.json'))) {
    return JSON.parse(readFileSync(join(cfg, 'fake-docs.json'), 'utf8'));
  }
  return [];
}

if (sub === 'auth' && rest[0] === 'status') {
  const authed =
    process.env.FAKE_AUTH !== undefined ? process.env.FAKE_AUTH === '1' : cfg !== undefined && existsSync(statePath('fake-auth'));
  out({ success: true, authenticated: authed, message: authed ? undefined : 'not logged in' });
}
if (sub === 'auth' && rest[0] === 'login') {
  if (process.env.FAKE_AUTH === undefined && cfg) writeFileSync(statePath('fake-auth'), new Date().toISOString());
  console.log('fake login ok');
  process.exit(0);
}
if (sub === 'contact' && rest[0] === 'user' && rest[1] === 'get') {
  const ids = (flag('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const users = process.env.FAKE_USERS
    ? JSON.parse(process.env.FAKE_USERS)
    : cfg && existsSync(join(cfg, 'fake-users.json'))
      ? JSON.parse(readFileSync(join(cfg, 'fake-users.json'), 'utf8'))
      : {};
  // 与真实 dws 对齐：--ids 支持 CSV，逐个命中并保序返回
  const result = ids
    .filter((id) => users[id])
    .map((id) => ({ orgEmployeeModel: { orgUserId: id, orgUserName: users[id] } }));
  out({ success: true, result });
}
if (sub === 'drive' && rest[0] === '+search-docs') {
  const query = flag('query') ?? '';
  const limit = Number(flag('limit') ?? 10);
  const docs = readFakeDocs();
  const items = docs
    .filter((d) => d.name.includes(query))
    .slice(0, Number.isFinite(limit) ? limit : 10)
    .map((d) => ({ nodeId: d.nodeId, name: d.name }));
  out({ success: true, items });
}
if (sub === 'doc' && rest[0] === 'read') {
  const node = flag('node');
  const doc = readFakeDocs().find((d) => d.nodeId === node);
  if (!doc) {
    console.error(`fake-dws: document ${node} not found`);
    process.exit(1);
  }
  out({ success: true, nodeId: doc.nodeId, name: doc.name, markdown: doc.markdown ?? '' });
}
if (sub === 'todo' && rest[0] === '+create') {
  const title = flag('title');
  const executors = flag('executors');
  if (title === undefined || executors === undefined) {
    console.error(`fake-dws: todo +create requires --title and --executors, got ${rest.join(' ')}`);
    process.exit(2);
  }
  const record = { title, executors };
  for (const f of ['due', 'priority']) {
    const v = flag(f);
    if (v !== undefined) record[f] = v;
  }
  if (process.env.FAKE_TODO_OUT) {
    appendFileSync(process.env.FAKE_TODO_OUT, JSON.stringify(record) + '\n');
  } else if (cfg) {
    appendFileSync(statePath('todos.ndjson'), JSON.stringify(record) + '\n');
  }
  out({ success: true, taskId: `fake-todo-${Date.now()}`, ...record });
}
if (sub === 'chat' && rest[0] === 'message' && rest[1] === 'send') {
  const to = flag('group') ?? flag('conversation-id') ?? flag('user') ?? flag('open-dingtalk-id');
  // 只认 dws 文档旗标 --content：调用方若漂移到未文档化别名，这里直接失败暴露契约
  const text = flag('content');
  if (to === undefined || text === undefined) {
    console.error(`fake-dws: send requires --group/--conversation-id/--user and --content, got ${rest.join(' ')}`);
    process.exit(2);
  }
  if (process.env.FAKE_SEND_FAIL === '1') {
    console.error('fake-dws: send failed (injected)');
    process.exit(1);
  }
  if (process.env.FAKE_SEND_OUT) {
    appendFileSync(process.env.FAKE_SEND_OUT, JSON.stringify({ to, text }) + '\n');
  } else if (cfg) {
    appendFileSync(statePath('sent.ndjson'), JSON.stringify({ to, text }) + '\n');
  }
  out({ success: true, messageIds: ['fake-msg-' + Date.now()] });
}
// 消息资源台账桩：与真实 dws 同键（resourceType/resourceId/messageId/localPath/sizeBytes），
// 落盘按进程 cwd 解析相对路径，绝对路径与 .. 逃逸一律拒绝，便于在没有真实钉钉资源时验证通路。
if (sub === 'chat' && rest[0] === '+messages-mget') {
  const msgIds = (flag('msg-ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (msgIds.length === 0) {
    console.error(`fake-dws: messages-mget requires --msg-ids, got ${rest.join(' ')}`);
    process.exit(2);
  }
  const resources = process.env.FAKE_MSG_RESOURCES
    ? JSON.parse(process.env.FAKE_MSG_RESOURCES)
    : cfg && existsSync(join(cfg, 'fake-resources.json'))
      ? JSON.parse(readFileSync(join(cfg, 'fake-resources.json'), 'utf8'))
      : {};
  const download = rest.includes('--download-resources');
  const outputDir = flag('output-dir') ?? 'downloads';
  if (/^\//.test(outputDir) || outputDir.split('/').includes('..')) {
    console.error(JSON.stringify({ error: { category: 'validation', code: 3, message: '--output-dir 只接受工作目录内的相对路径' } }));
    process.exit(3);
  }
  if (process.env.FAKE_MGET_FAIL === '1') {
    console.error('fake-dws: mget failed (injected)');
    process.exit(1);
  }
  const signatures = {
    png: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    jpeg: () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    // 每种都带一段正文，长度与真实文件头一致：平台按文件头识别，过短的桩会被当成非图片跳过
    gif: () => Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([1, 0, 1, 0, 0, 0])]),
    webp: () =>
      Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.from([20, 0, 0, 0]),
        Buffer.from('WEBP', 'ascii'),
        Buffer.from('VP8 ', 'ascii'),
        Buffer.from([4, 0, 0, 0]),
      ]),
    bmp: () => Buffer.concat([Buffer.from('BM', 'ascii'), Buffer.alloc(12)]),
    mp4: () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('mp42', 'ascii')]),
    pdf: () => Buffer.from('%PDF-1.4', 'ascii'),
  };
  const targetDir = join(process.cwd(), outputDir);
  const downloads = [];
  const discovered = [];
  for (const id of msgIds) {
    for (const res of resources[id] ?? []) {
      discovered.push(res);
      if (!download) continue;
      const kind = res.kind ?? 'png';
      const make = signatures[kind];
      if (!make) continue;
      const fileName = `${String(res.resourceId ?? 'res').replace(/[^\w.-]/g, '_')}.${kind}`;
      const localPath = `${outputDir}/${fileName}`;
      const bytes = make();
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(process.cwd(), localPath), bytes);
      downloads.push({
        resourceType: res.resourceType ?? 'mediaId',
        resourceId: res.resourceId ?? 'fake-res',
        messageId: id,
        localPath,
        sizeBytes: bytes.length,
      });
    }
  }
  out({
    contractVersion: 'im.message-list.v1',
    success: true,
    complete: true,
    requestedCount: msgIds.length,
    foundCount: msgIds.filter((id) => resources[id]).length,
    messages: msgIds.map((id) => ({ messageId: id, text: '' })),
    resourceDownloads: {
      ok: true,
      partial: false,
      discoveredCount: discovered.length,
      requestedCount: download ? discovered.length : 0,
      deduplicatedCount: 0,
      downloadedCount: downloads.length,
      failedCount: 0,
      downloads,
      failures: [],
    },
  });
}
if (sub === 'event' && rest[0] === 'consume') {
  const inbox = cfg && existsSync(join(cfg, 'inbox.ndjson')) ? readFileSync(join(cfg, 'inbox.ndjson'), 'utf8') : '';
  process.stderr.write('[event] ready\n');
  for (const line of inbox.split('\n')) {
    if (line.trim()) process.stdout.write(line.trim() + '\n');
  }
  // 事件流常驻直到收到终止信号（SIGTERM/关 stdin），模拟真实长连接
  const bye = () => process.exit(0);
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
  setInterval(() => undefined, 60_000);
} else {
  console.error(`fake-dws: unrecognized invocation ${process.argv.slice(2).join(' ')}`);
  process.exit(2);
}
