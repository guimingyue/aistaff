import { DirectoryAdapter, AuthStatus, DirectoryUser } from './directory-adapter';

/**
 * 通道策略（设计文档 §7）：一期先钉钉，飞书复用同一 DirectoryAdapter 抽象在二期落地。
 * 保持类存在是为了注册表口径完整；调用即显式失败，不静默降级。
 */
export class FeishuAdapter implements DirectoryAdapter {
  readonly provider = 'FEISHU' as const;

  private refuse(): never {
    throw new Error('Feishu channel arrives in phase 2 (phase 1 supports DINGTALK only; see docs/design.md channel strategy)');
  }

  authStatus(): Promise<AuthStatus> {
    this.refuse();
  }

  verifyUser(_externalUserId: string): Promise<DirectoryUser | null> {
    this.refuse();
  }

  loginInteractive(_orgProfile?: string): Promise<number> {
    this.refuse();
  }
}
