#!/usr/bin/env node
// 测试/E2E 验证用假 CLI：契约与 dws 对齐（auth status/login、contact user get、
// chat message send、event consume）。行为优先由 FAKE_* 环境变量驱动（单测注入），
// 环境变量缺省时回落到 profile 目录状态文件（DWS_CONFIG_DIR 下 fake-auth /
// fake-users.json / inbox.ndjson / sent.ndjson），使跨进程验证脚本可用同一
// 隔离 profile 布置与观测。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [sub, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const cfg = process.env.DWS_CONFIG_DIR;
const statePath = (name) => {
  if (!cfg) throw new Error('fake-dws: 状态文件模式需要 DWS_CONFIG_DIR');
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

if (sub === 'auth' && rest[0] === 'status') {
  const authed =
    process.env.FAKE_AUTH !== undefined ? process.env.FAKE_AUTH === '1' : cfg !== undefined && existsSync(statePath('fake-auth'));
  out({ success: true, authenticated: authed, message: authed ? undefined : '未登录' });
}
if (sub === 'auth' && rest[0] === 'login') {
  if (process.env.FAKE_AUTH === undefined && cfg) writeFileSync(statePath('fake-auth'), new Date().toISOString());
  console.log('fake login ok');
  process.exit(0);
}
if (sub === 'contact' && rest[0] === 'user' && rest[1] === 'get') {
  const id = flag('ids');
  const users = process.env.FAKE_USERS
    ? JSON.parse(process.env.FAKE_USERS)
    : cfg && existsSync(join(cfg, 'fake-users.json'))
      ? JSON.parse(readFileSync(join(cfg, 'fake-users.json'), 'utf8'))
      : {};
  const hit = users[id];
  out({
    success: true,
    result: hit ? [{ orgEmployeeModel: { orgUserId: id, orgUserName: hit } }] : [],
  });
}
if (sub === 'chat' && rest[0] === 'message' && rest[1] === 'send') {
  const to = flag('group') ?? flag('user') ?? flag('open-dingtalk-id');
  const text = flag('text') ?? rest[rest.length - 1];
  if (process.env.FAKE_SEND_FAIL === '1') {
    console.error('fake-dws: 发送失败（注入）');
    process.exit(1);
  }
  if (process.env.FAKE_SEND_OUT) {
    appendFileSync(process.env.FAKE_SEND_OUT, JSON.stringify({ to, text }) + '\n');
  } else if (cfg) {
    appendFileSync(statePath('sent.ndjson'), JSON.stringify({ to, text }) + '\n');
  }
  out({ success: true, messageIds: ['fake-msg-' + Date.now()] });
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
  console.error(`fake-dws: 未识别的调用 ${process.argv.slice(2).join(' ')}`);
  process.exit(2);
}
