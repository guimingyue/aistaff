import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AgentRunner, RunTurnRequest, RunTurnResult } from './agent-runner';
import { PiAgentRunner } from './pi-agent-runner';

/**
 * 显式验证桩：不触模型，回显输入并维护伪会话档案。
 * 仅当 AISTAFF_AGENT_RUNNER=echo 时启用——用于无模型凭证环境下验证
 * chat 链路（装配入参、sessions.db 持久化、审计），真实对话必须走 pi runner。
 */
export class EchoAgentRunner implements AgentRunner {
  readonly kind = 'echo';

  async runTurn(req: RunTurnRequest): Promise<RunTurnResult> {
    const sessionFile =
      req.sessionFile ?? resolve(req.workspaceDir, `.aistaff-agent/sessions/echo-${req.employeeNo}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ employeeNo: req.employeeNo, prompt: req.systemPrompt.slice(0, 40) }) + '\n', {
      flag: 'a',
    });
    return {
      replyText: `[echo:${req.employeeNo}] ${req.message}`,
      sessionFile,
      modelUsed: 'echo-stub',
    };
  }
}

export function createAgentRunnerFromEnv(): AgentRunner {
  return process.env.AISTAFF_AGENT_RUNNER === 'echo' ? new EchoAgentRunner() : new PiAgentRunner();
}
