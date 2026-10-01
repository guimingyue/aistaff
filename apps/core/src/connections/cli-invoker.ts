import { execFile, spawn } from 'node:child_process';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 一律 argv 数组 + execFile（无 shell），杜绝消息内容/外部 ID 拼接 shell 的注入面。
 * cwd 用于把 CLI 的"工作目录"钉到员工 workspace——dws 的下载类命令只接受工作目录内的相对路径。
 */
export function runCli(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env, maxBuffer: 10 * 1024 * 1024, timeout: 60_000, ...(cwd ? { cwd } : {}) },
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

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 标识符类外部输入（会话 ID、三方用户 ID）收口为 `--flag=value` 单 argv：
 * 值以 `-` 开头时会被 CLI 当成旗标解析，`=` 形式消除该歧义（dws v1.0.62 实测支持）。
 */
export function cliIdArg(flag: string, value: string): string {
  if (!value || value.length > 512) {
    throw new Error(`${flag}: identifier must be 1-512 characters`);
  }
  if (value.startsWith('-')) {
    throw new Error(`${flag}: identifier must not start with "-"`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new Error(`${flag}: identifier must not contain control characters`);
  }
  return `--${flag}=${value}`;
}

/** 自由文本（消息正文，来自模型输出）：内容不做字符限制，仅排除 NUL，同样用 `=` 形式传递。 */
export function cliTextArg(flag: string, value: string): string {
  if (value.includes('\u0000')) {
    throw new Error(`${flag}: text must not contain NUL characters`);
  }
  return `--${flag}=${value}`;
}
