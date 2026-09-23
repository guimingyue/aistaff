import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AGENT_RUNNER } from './agent-runner';
import { createAgentRunnerFromEnv } from './echo-runner';

@Module({
  controllers: [ChatController],
  providers: [ChatService, { provide: AGENT_RUNNER, useFactory: createAgentRunnerFromEnv }],
  exports: [ChatService, AGENT_RUNNER],
})
export class AgentRuntimeModule {}
