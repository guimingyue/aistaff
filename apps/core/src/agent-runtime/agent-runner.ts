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
  /** data/workspaces/<employeeNo>/，员工文件类工具的工作目录 */
  workspaceDir: string;
  /** 既有 pi 会话档案路径；undefined 表示新会话 */
  sessionFile?: string;
}

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
