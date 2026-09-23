export interface AuthStatus {
  authenticated: boolean;
  detail?: unknown;
}

export interface DirectoryUser {
  externalUserId: string;
  name: string;
}

/**
 * 三方身份源适配器（设计文档 §4）。M3 覆盖 login/verifyUser/status；
 * subscribe/send 在 M5 message-loop 中补充实现。
 */
export interface DirectoryAdapter {
  readonly provider: 'DINGTALK' | 'FEISHU';
  authStatus(): Promise<AuthStatus>;
  verifyUser(externalUserId: string): Promise<DirectoryUser | null>;
  loginInteractive(orgProfile?: string): Promise<number>;
}
