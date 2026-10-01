import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { AgentImage } from '../agent-runtime/agent-runner';

/**
 * `dws chat +messages-mget --download-resources` 的资源台账。
 * 条目键固定为 resourceType/resourceId/messageId/localPath/sizeBytes，
 * 其中 localPath 是相对 CLI 工作目录的路径（CLI 侧已禁止绝对路径与 .. 逃逸，此处再校验一次）。
 */
export interface ResourceDownloadEntry {
  resourceType?: string;
  resourceId?: string;
  messageId?: string;
  localPath?: string;
  sizeBytes?: number;
}

export interface ResourceLedger {
  discoveredCount: number;
  failedCount: number;
  downloads: ResourceDownloadEntry[];
}

export function parseResourceLedger(payload: unknown): ResourceLedger {
  const ledger = (payload as { resourceDownloads?: Record<string, unknown> } | null)?.resourceDownloads;
  const downloads = ledger?.downloads;
  return {
    discoveredCount: Number(ledger?.discoveredCount ?? 0) || 0,
    failedCount: Number(ledger?.failedCount ?? 0) || 0,
    downloads: Array.isArray(downloads) ? (downloads as ResourceDownloadEntry[]) : [],
  };
}

/**
 * 资源台账只区分 mediaId 与 fileId，不告诉调用方媒体是不是图片，
 * 因此类型判定以文件头为准，而不是 CLI 落盘用的文件名或扩展名。
 */
const IMAGE_SIGNATURES: Array<{ mimeType: string; matches: (buf: Buffer) => boolean }> = [
  {
    mimeType: 'image/png',
    matches: (b) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString('ascii') === 'PNG',
  },
  {
    mimeType: 'image/jpeg',
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mimeType: 'image/gif',
    matches: (b) => b.length > 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii')),
  },
  {
    mimeType: 'image/webp',
    matches: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  { mimeType: 'image/bmp', matches: (b) => b.length > 2 && b.subarray(0, 2).toString('ascii') === 'BM' },
];

export function sniffImageMimeType(buf: Buffer): string | undefined {
  return IMAGE_SIGNATURES.find((sig) => sig.matches(buf))?.mimeType;
}

export interface MediaLimits {
  maxImages: number;
  maxImageBytes: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** 图片不进对话上下文就没人知道它存在，但 base64 会直接吃上下文，所以张数与体积都必须有顶。 */
export function mediaLimitsFromEnv(source: Record<string, string | undefined> = process.env): MediaLimits {
  return {
    maxImages: positiveInt(source.AISTAFF_MEDIA_MAX_IMAGES, 3),
    maxImageBytes: positiveInt(source.AISTAFF_MEDIA_MAX_IMAGE_BYTES, 4 * 1024 * 1024),
  };
}

/**
 * 是否值得为一个 @消息多跑一次资源下载。@消息事件里没有消息类型字段，
 * 媒体消息只以 `mediaId:` / `fileId:` 标记出现在正文（与 dws 自身的资源识别正则同源），
 * 纯文本因此不会多付一次 CLI 往返。
 */
const RESOURCE_MARKER = /(?:media|file)[_-]?id\s*[:=]/i;

export function mayCarryResources(content: string): boolean {
  return !content.trim() || RESOURCE_MARKER.test(content);
}

/**
 * 把台账里成功的下载读成模型可用的图片：跳过非图片、超体积、超出张数与任何越界路径。
 * 越界路径本应由 CLI 拦住，这里是第二道闸——落盘路径来自外部返回值，不能直接信任。
 */
export async function readImagesFromLedger(
  ledger: ResourceLedger,
  workspaceDir: string,
  limits: MediaLimits,
): Promise<AgentImage[]> {
  const images: AgentImage[] = [];
  for (const entry of ledger.downloads) {
    if (images.length >= limits.maxImages) break;
    const localPath = entry.localPath;
    if (!localPath || isAbsolute(localPath)) continue;
    const absolute = resolve(workspaceDir, localPath);
    if (!absolute.startsWith(workspaceDir + sep)) continue;
    if (Number(entry.sizeBytes ?? 0) > limits.maxImageBytes) continue;
    let buf: Buffer;
    try {
      buf = await readFile(absolute);
    } catch {
      continue;
    }
    if (buf.length === 0 || buf.length > limits.maxImageBytes) continue;
    const mimeType = sniffImageMimeType(buf);
    if (!mimeType) continue;
    images.push({ data: buf.toString('base64'), mimeType });
  }
  return images;
}
