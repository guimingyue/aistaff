import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  describe('入站图片取回', () => {
    const mediaChannel = (extra: Record<string, string>) =>
      new DwsAtChannel(
        FAKE_BIN,
        isolatedEnv(join(dir, 'media-profile'), {
          FAKE_ARGV_OUT: argvOut.file,
          FAKE_MSG_RESOURCES: JSON.stringify({
            'msg-1': [
              { resourceId: 'med-1', kind: 'png' },
              { resourceId: 'med-2', kind: 'mp4' },
            ],
          }),
          ...extra,
        }),
      );

    it('argv 契约与工作目录：图片落在员工 workspace 内，非图片资源被跳过', async () => {
      const ws = join(dir, 'ws-media');
      mkdirSync(ws, { recursive: true });
      const media = await mediaChannel({}).fetchImages('msg-1', ws);
      assert.deepEqual(argvLines(argvOut.file).at(-1)!, [
        'chat',
        '+messages-mget',
        '--msg-ids=msg-1',
        '--download-resources',
        '--no-threads',
        '--no-reactions',
        '--output-dir=inbox',
        '-f',
        'json',
      ]);
      assert.equal(media.discoveredCount, 2);
      assert.equal(media.skippedCount, 1, '视频资源不得混进图片');
      assert.equal(media.images.length, 1);
      assert.equal(media.images[0].mimeType, 'image/png');
      assert.equal(Buffer.from(media.images[0].data, 'base64').subarray(1, 4).toString('ascii'), 'PNG');
      assert.ok(existsSync(join(ws, 'inbox', 'med-1.png')), '落盘目录由平台常量决定，必须在员工 workspace 内');
    });

    it('真实 openMessageId 形态（含 / + =）作为单 argv 送达，空 ID 不落 CLI', async () => {
      const ws = join(dir, 'ws-id');
      mkdirSync(ws, { recursive: true });
      await mediaChannel({}).fetchImages('msgEtfiWuSrWL8EDfCUJYV2Kw==', ws);
      assert.equal(argvLines(argvOut.file).at(-1)![2], '--msg-ids=msgEtfiWuSrWL8EDfCUJYV2Kw==');
      const before = argvLines(argvOut.file).length;
      await assert.rejects(() => mediaChannel({}).fetchImages('', ws), /1-512 characters/);
      assert.equal(argvLines(argvOut.file).length, before);
    });

    it('假 CLI 的每种图片落盘都能被文件头认出（防止过短签名桩把能力测成假绿）', async () => {
      const ws = join(dir, 'ws-kinds');
      mkdirSync(ws, { recursive: true });
      // 缺省张数上限是 3，这里必须放宽才能一张不漏地验完五种签名
      process.env.AISTAFF_MEDIA_MAX_IMAGES = '5';
      try {
        const media = await mediaChannel({
          FAKE_MSG_RESOURCES: JSON.stringify({
            'msg-kinds': [
              { resourceId: 'k1', kind: 'png' },
              { resourceId: 'k2', kind: 'jpeg' },
              { resourceId: 'k3', kind: 'gif' },
              { resourceId: 'k4', kind: 'webp' },
              { resourceId: 'k5', kind: 'bmp' },
            ],
          }),
        }).fetchImages('msg-kinds', ws);
        assert.deepEqual(
          media.images.map((i) => i.mimeType),
          ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'],
        );
        assert.equal(media.skippedCount, 0);
      } finally {
        delete process.env.AISTAFF_MEDIA_MAX_IMAGES;
      }
    });

    it('体积上限经 env 生效；CLI 失败显式抛错，不静默当成无图', async () => {
      const ws = join(dir, 'ws-cap');
      mkdirSync(ws, { recursive: true });
      process.env.AISTAFF_MEDIA_MAX_IMAGE_BYTES = '1';
      try {
        const media = await mediaChannel({}).fetchImages('msg-1', ws);
        assert.deepEqual(media.images, [], '超体积的图不能进上下文');
        assert.equal(media.skippedCount, 2);
      } finally {
        delete process.env.AISTAFF_MEDIA_MAX_IMAGE_BYTES;
      }
      await assert.rejects(
        () => mediaChannel({ FAKE_MGET_FAIL: '1' }).fetchImages('msg-1', ws),
        /resource download failed/,
      );
    });
  });
});
