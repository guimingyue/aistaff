import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DirectoryAdapter, AuthStatus, DirectoryUser } from './directory-adapter';
import { runCli, runCliInteractive, parseJsonLoose } from './cli-invoker';

/** 每员工独立 CLI profile：HOME/XDG 与 DWS_CONFIG_DIR 全部指向专属目录，平台不触碰 token 本体。 */
export function isolatedEnv(
  profileDir: string,
  passthrough?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  mkdirSync(profileDir, { recursive: true });
  for (const sub of ['.config', '.local/share', '.cache', '.dws']) {
    mkdirSync(join(profileDir, sub), { recursive: true });
  }
  return {
    ...passthrough,
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: profileDir,
    XDG_CONFIG_HOME: join(profileDir, '.config'),
    XDG_DATA_HOME: join(profileDir, '.local', 'share'),
    XDG_STATE_HOME: join(profileDir, '.local', 'state'),
    XDG_CACHE_HOME: join(profileDir, '.cache'),
    DWS_CONFIG_DIR: join(profileDir, '.dws'),
    // macOS 钥匙串在隔离 HOME 下取 DEK 会超时（实测 device flow Step 4 失败），
    // 托管 CLI 也无法应答 GUI 弹窗；token 落隔离 profile 目录（已 gitignore）
    DWS_DISABLE_KEYCHAIN: '1',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  };
}

interface DwsUserRecord {
  orgEmployeeModel?: {
    orgUserId?: string;
    orgUserName?: string;
  };
}

export class DingtalkAdapter implements DirectoryAdapter {
  readonly provider = 'DINGTALK' as const;

  constructor(
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async authStatus(): Promise<AuthStatus> {
    const res = await runCli(this.bin, ['auth', 'status', '-f', 'json'], this.env);
    const parsed = parseJsonLoose(res.stdout) as
      | { authenticated?: boolean; success?: boolean }
      | null;
    return { authenticated: parsed?.authenticated === true, detail: parsed ?? res.stderr };
  }

  async verifyUser(externalUserId: string): Promise<DirectoryUser | null> {
    const res = await runCli(
      this.bin,
      ['contact', 'user', 'get', '--ids', externalUserId, '-f', 'json'],
      this.env,
    );
    if (res.code !== 0) return null;
    const parsed = parseJsonLoose(res.stdout) as
      | { result?: DwsUserRecord[]; success?: boolean }
      | DwsUserRecord[]
      | null;
    const records: DwsUserRecord[] = Array.isArray(parsed)
      ? parsed
      : (parsed?.result ?? []);
    for (const r of records) {
      if (r.orgEmployeeModel?.orgUserId === externalUserId) {
        return {
          externalUserId,
          name: (r.orgEmployeeModel.orgUserName ?? '').trim(),
        };
      }
    }
    return null;
  }

  /** 设备流：服务端进程无浏览器可用，授权链接/码经 core 日志与 CLI 转给员工本人。 */
  loginInteractive(orgProfile?: string): Promise<number> {
    const args = ['auth', 'login', '--device'];
    if (orgProfile) {
      // argv 值若以 - 开头会被 CLI 解析成旗标；corpId 形态白名单收口
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgProfile)) {
        throw new Error(`组织 ID 格式非法：${orgProfile.slice(0, 20)}`);
      }
      args.push('--profile', orgProfile);
    }
    return runCliInteractive(this.bin, args, this.env);
  }
}

export function dingtalkAdapterFactory(bin: string) {
  return (profileDir: string): DirectoryAdapter =>
    new DingtalkAdapter(bin, isolatedEnv(profileDir));
}
