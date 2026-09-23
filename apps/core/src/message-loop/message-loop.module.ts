import { Module } from '@nestjs/common';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';
import { MessageLoopService } from './message-loop.service';
import { MessageLoopController } from './message-loop.controller';
import { LOOP_PROVIDERS } from './channel';
import { dingtalkLoopProvider } from './dingtalk-loop.channel';

@Module({
  imports: [AgentRuntimeModule],
  controllers: [MessageLoopController],
  providers: [
    MessageLoopService,
    {
      provide: LOOP_PROVIDERS,
      useValue: { DINGTALK: dingtalkLoopProvider(process.env.AISTAFF_DWS_BIN ?? 'dws') },
    },
  ],
  exports: [MessageLoopService],
})
export class MessageLoopModule {}
