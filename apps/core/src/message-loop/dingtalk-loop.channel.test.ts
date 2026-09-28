import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DwsAtChannel } from './dingtalk-loop.channel';
import { runCli } from '../connections/cli-invoker';
import { isolatedEnv } from '../connections/dingtalk.adapter';

const FAKE_BIN = join(__dirname, '..', 'connections', 'testing', 'fake-dws.mjs');

function argvLines(file: string): string[][] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('dingtalk 通道 argv 契约（假 CLI）', () => {
  let dir: string;
  let channel: DwsAtChannel;
  const argvOut = { file: '' };
  const sendOut = { file: '' };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'aistaff-argv-'));
    argvOut.file = join(dir, 'argv.log');
    sendOut.file = join(dir, 'send.log');
    channel = new DwsAtChannel(
      FAKE_BIN,
      isolatedEnv(join(dir, 'profile'), {
        FAKE_ARGV_OUT: argvOut.file,
        FAKE_SEND_OUT: sendOut.file,
      }),
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('发送使用文档旗标 --group=/--content= 单 argv 形式，正文原样送达', async () => {
    const evilText = String.raw`答：x" && touch ${join(dir, 'pwned')} # 换行\n保留`;
    await channel.send('cid-real-group', evilText);
    const argv = argvLines(argvOut.file).at(-1)!;
    assert.deepEqual(argv, [
      'chat',
      'message',
      'send',
      '--group=cid-real-group',
      `--content=${evilText}`,
      '-y',
      '-f',
      'json',
    ]);
    const sent = JSON.parse(readFileSync(sendOut.file, 'utf8').trim().split('\n').at(-1)!);
    assert.deepEqual(sent, { to: 'cid-real-group', text: evilText });
  });

  it('以 - 开头或含控制字符的会话 ID 被拒绝，不落到 CLI', async () => {
    const before = argvLines(argvOut.file).length;
    await assert.rejects(() => channel.send('--at-all', 'x'), /must not start with "-"/);
    await assert.rejects(() => channel.send('cid\u0007bell', 'x'), /control characters/);
    await assert.rejects(() => channel.send('', 'x'), /1-512 characters/);
    await assert.rejects(() => channel.send('cid', 'a\u0000b'), /NUL/);
    assert.equal(argvLines(argvOut.file).length, before, '非法输入不得产生 CLI 调用');
  });

  it('假 CLI 只认 --content：调用方漂移到未文档化别名会显式失败', async () => {
    const env = isolatedEnv(join(dir, 'profile2'), {});
    const res = await runCli(
      FAKE_BIN,
      ['chat', 'message', 'send', '--group=cid-x', '--text=hi', '-y', '-f', 'json'],
      env,
    );
    assert.equal(res.code, 2);
    assert.match(res.stderr, /requires/);
  });
});
