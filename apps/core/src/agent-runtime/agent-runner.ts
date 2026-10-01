export interface AgentImage {
  /** base64，不含 data: 前缀 */
  data: string;
  mimeType: string;
}

export interface RunTurnRequest {
  employeeNo: string;
  /** 员工显示名，人格缺省组装用 */
  name: string;
  /** 人格系统提示（AgentProfile.systemPrompt 或平台缺省人格） */
  systemPrompt: string;
  /** "provider/model" 形态；缺省由运行时按可用模型决断 */
  model?: string;
  /** 工具白名单；undefined=运行时默认，[]=显式禁用全部工具 */
  tools?: string[];
  message: string;
  /** 随消息附带的图片（base64，无 data: 前缀）；模型不支持图像输入时运行时应拒绝而不是静默丢弃 */
  images?: AgentImage[];
  /** data/workspaces/<employeeNo>/，员工文件类工具的工作目录 */
  workspaceDir: string;
  /**
   * 该员工三方 CLI 的隔离环境（专属 profile 目录）。缺省表示员工尚未绑定外部账号，
   * 此时不注册任何会触碰组织系统的工具。
   */
  cliEnv?: NodeJS.ProcessEnv;
  /** 既有 pi 会话档案路径；undefined 表示新会话 */
  sessionFile?: string;
  /** 取消信号：超时或停机时中止本轮（运行时应尽快释放模型连接与子进程） */
  signal?: AbortSignal;
  /** 本轮处理过程事件回调（工具调用/结果；thinking 仅 AISTAFF_SHOW_THINKING=1 时产生） */
  onEvent?: (event: AgentStepEvent) => void;
}

export type AgentStepEvent =
  | { type: 'tool_call'; toolName: string; argsPreview?: string }
  | { type: 'tool_result'; toolName: string; isError: boolean; resultPreview?: string }
  | { type: 'thinking'; text: string }
  /** 上下文压缩：长会话每次请求前触发，多花一次模型调用，用于解释耗时 */
  | {
      type: 'compaction';
      reason: 'manual' | 'threshold' | 'overflow';
      ok: boolean;
      tokensBefore?: number;
      estimatedTokensAfter?: number;
      errorMessage?: string;
    };

export interface RunTurnResult {
  replyText: string;
  /** 本轮落盘的 pi 会话档案，回写 Conversation.agentSessionFile 供下轮延续 */
  sessionFile: string;
  modelUsed?: string;
}

export interface AgentRunner {
  readonly kind: string;
  runTurn(req: RunTurnRequest): Promise<RunTurnResult>;
}

export const AGENT_RUNNER = Symbol('AGENT_RUNNER');
