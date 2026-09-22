import { execFile, spawn } from 'node:child_process';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 一律 argv 数组 + execFile（无 shell），杜绝消息内容/外部 ID 拼接 shell 的注入面。
 */
export function runCli(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as unknown) as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** 登录等交互场景：继承 stdio 让扫码/授权 UI 直达终端。 */
export function runCliInteractive(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // CLI 偶尔在 JSON 前后带日志行，取第一个 {..} / [..] 片段
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  }
}
