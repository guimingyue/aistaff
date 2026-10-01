import type { AgentImage } from '../agent-runtime/agent-runner';

export interface InboundMessage {
  /** 事件 ID，用于去重 */
  eventId: string;
  messageId?: string;
  /** 三方会话标识（钉钉 openConversationId） */
  conversationId: string;
  senderName?: string;
  senderOpenDingTalkId?: string;
  /** 消息正文；空串表示非文本等一期降级消息 */
  content: string;
}

export interface InboundMedia {
  /** 成功取回、可交给模型的图片 */
  images: AgentImage[];
  /** 消息里可识别的资源总数 */
  discoveredCount: number;
  /** 因类型不支持、超张数或超体积而未交给模型的资源数 */
  skippedCount: number;
}

export interface LoopChannel {
  start(handlers: {
    onMessage(msg: InboundMessage): void;
    onDiagnostic(line: string): void;
    onExit(code: number | null): void;
  }): Promise<void>;
  send(conversationId: string, text: string): Promise<void>;
  stop(): Promise<void>;
  /**
   * 取回一条消息附带的图片（三方 CLI 资源下载能力存在时才实现）。
   * workspaceDir 决定落盘的工作目录，返回的图片为 base64，可直接交给 Agent 运行。
   */
  fetchImages?(messageId: string, workspaceDir: string): Promise<InboundMedia>;
}

export interface LoopProvider {
  /** profile 登录态探测（复用 DirectoryAdapter.authStatus 语义） */
  authStatus(profileDir: string): Promise<boolean>;
  channel(profileDir: string): LoopChannel;
}

export const LOOP_PROVIDERS = Symbol('LOOP_PROVIDERS');
