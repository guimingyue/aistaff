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

export interface LoopChannel {
  start(handlers: {
    onMessage(msg: InboundMessage): void;
    onDiagnostic(line: string): void;
    onExit(code: number | null): void;
  }): Promise<void>;
  send(conversationId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

export interface LoopProvider {
  /** profile 登录态探测（复用 DirectoryAdapter.authStatus 语义） */
  authStatus(profileDir: string): Promise<boolean>;
  channel(profileDir: string): LoopChannel;
}

export const LOOP_PROVIDERS = Symbol('LOOP_PROVIDERS');
