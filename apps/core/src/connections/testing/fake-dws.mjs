#!/usr/bin/env node
// 测试用假 CLI：契约与 dws 对齐（auth status / contact user get / auth login），
// 行为由 FAKE_* 环境变量驱动；记录 argv 与 HOME 供隔离/注入断言。
import { appendFileSync, writeFileSync } from 'node:fs';

const [sub, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
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
  out({ success: true, authenticated: process.env.FAKE_AUTH === '1', message: process.env.FAKE_AUTH === '1' ? undefined : '未登录' });
}
if (sub === 'auth' && rest[0] === 'login') {
  console.log('fake login ok');
  process.exit(0);
}
if (sub === 'contact' && rest[0] === 'user' && rest[1] === 'get') {
  const id = flag('ids');
  const users = JSON.parse(process.env.FAKE_USERS ?? '{}');
  const hit = users[id];
  out({
    success: true,
    result: hit ? [{ orgEmployeeModel: { orgUserId: id, orgUserName: hit } }] : [],
  });
}
console.error(`fake-dws: 未识别的调用 ${process.argv.slice(2).join(' ')}`);
process.exit(2);
