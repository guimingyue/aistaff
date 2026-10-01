import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  mayCarryResources,
  mediaLimitsFromEnv,
  parseResourceLedger,
  readImagesFromLedger,
  sniffImageMimeType,
} from './media';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp', 'ascii'), Buffer.from('mp42', 'ascii')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([20, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('VP8 ', 'ascii'),
  Buffer.from([4, 0, 0, 0]),
]);

describe('入站图片资源台账', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'aistaff-media-'));
    // 与真实通路一致：CLI 把资源落在工作目录的 inbox/ 下
    mkdirSync(join(dir, 'inbox'), { recursive: true });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const put = (rel: string, bytes: Buffer) => {
    writeFileSync(join(dir, rel), bytes);
    return rel;
  };

  it('只认文件头，不认 CLI 落盘的文件名', async () => {
    assert.equal(sniffImageMimeType(PNG), 'image/png');
    assert.equal(sniffImageMimeType(JPEG), 'image/jpeg');
    assert.equal(sniffImageMimeType(WEBP), 'image/webp');
    assert.equal(sniffImageMimeType(MP4), undefined);
    // 台账只分 mediaId/fileId：叫 .png 的视频同样不会被当成图片
    const fakeName = put('inbox/lying.png', MP4);
    const images = await readImagesFromLedger(
      { discoveredCount: 1, failedCount: 0, downloads: [{ localPath: fakeName, sizeBytes: MP4.length }] },
      dir,
      { maxImages: 3, maxImageBytes: 1024 },
    );
    assert.deepEqual(images, []);
  });

  it('台账解析：缺字段/形状不对都退化为无资源而不是抛错', () => {
    assert.deepEqual(parseResourceLedger(null), { discoveredCount: 0, failedCount: 0, downloads: [] });
    assert.deepEqual(parseResourceLedger({ other: 1 }), { discoveredCount: 0, failedCount: 0, downloads: [] });
    assert.deepEqual(parseResourceLedger({} ), { discoveredCount: 0, failedCount: 0, downloads: [] });
    const ok = parseResourceLedger({
      resourceDownloads: {
        discoveredCount: '2',
        failedCount: 1,
        downloads: [{ localPath: 'inbox/a.png', resourceId: 'a', sizeBytes: 12 }],
      },
    });
    assert.equal(ok.discoveredCount, 2);
    assert.equal(ok.failedCount, 1);
    assert.equal(ok.downloads.length, 1);
  });

  it('读图：保序、跳非图片、跳超限、张数封顶', async () => {
    const a = put('inbox/a.png', PNG);
    const b = put('inbox/b.mp4', MP4);
    const c = put('inbox/c.jpg', JPEG);
    const big = put('inbox/big.png', Buffer.concat([PNG, Buffer.alloc(4096)]));
    const ledger = {
      discoveredCount: 4,
      failedCount: 0,
      downloads: [
        { localPath: a, sizeBytes: PNG.length },
        { localPath: b, sizeBytes: MP4.length },
        { localPath: big, sizeBytes: 4108 },
        { localPath: c, sizeBytes: JPEG.length },
      ],
    };
    const images = await readImagesFromLedger(ledger, dir, { maxImages: 3, maxImageBytes: 100 });
    assert.deepEqual(
      images.map((i) => i.mimeType),
      ['image/png', 'image/jpeg'],
      '视频与超体积图必须跳过',
    );
    assert.equal(Buffer.from(images[0].data, 'base64').equals(PNG), true);
    assert.equal(Buffer.from(images[1].data, 'base64').equals(JPEG), true);

    const capped = await readImagesFromLedger(ledger, dir, { maxImages: 1, maxImageBytes: 100 });
    assert.equal(capped.length, 1, '张数上限必须生效');
  });

  it('sizeBytes 只是预筛，落盘体积超标仍然丢弃', async () => {
    const lies = put('inbox/lies.png', Buffer.concat([PNG, Buffer.alloc(2048)]));
    const images = await readImagesFromLedger(
      { discoveredCount: 1, failedCount: 0, downloads: [{ localPath: lies, sizeBytes: 12 }] },
      dir,
      { maxImages: 3, maxImageBytes: 100 },
    );
    assert.deepEqual(images, []);
  });

  it('越界路径一律拒绝：绝对路径、.. 逃逸、不存在的文件', async () => {
    const missing = 'inbox/gone.png';
    const images = await readImagesFromLedger(
      {
        discoveredCount: 3,
        failedCount: 0,
        downloads: [
          { localPath: join(dir, 'a.png'), sizeBytes: PNG.length },
          { localPath: '../escape.png', sizeBytes: PNG.length },
          { localPath: missing, sizeBytes: PNG.length },
        ],
      },
      dir,
      { maxImages: 3, maxImageBytes: 1024 },
    );
    assert.deepEqual(images, []);
  });

  it('上限来自 env，非法值回落默认而不是把图片能力关掉', () => {
    assert.deepEqual(mediaLimitsFromEnv({}), { maxImages: 3, maxImageBytes: 4 * 1024 * 1024 });
    assert.deepEqual(mediaLimitsFromEnv({ AISTAFF_MEDIA_MAX_IMAGES: '1', AISTAFF_MEDIA_MAX_IMAGE_BYTES: '1024' }), {
      maxImages: 1,
      maxImageBytes: 1024,
    });
    for (const bad of ['', 'abc', '0', '-2', '1.5']) {
      assert.equal(mediaLimitsFromEnv({ AISTAFF_MEDIA_MAX_IMAGES: bad }).maxImages, 3);
    }
  });

  it('纯文本不触发资源探测，带 mediaId/fileId 标记或空正文才触发', () => {
    assert.equal(mayCarryResources('帮我查下周三的会'), false);
    assert.equal(mayCarryResources('https://example.com/a?x=1'), false);
    assert.equal(mayCarryResources('[图片] mediaId:abc123'), true);
    assert.equal(mayCarryResources('看下这个 [文件] 报价单 fileId: f-9'), true);
    assert.equal(mayCarryResources(''), true);
    assert.equal(mayCarryResources('   '), true);
  });
});
