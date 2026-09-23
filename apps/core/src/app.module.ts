import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { ConfigModule } from './config/config.module';
import { StaffModule } from './staff/staff.module';
import { ConnectionsModule } from './connections/connections.module';
import { AgentRuntimeModule } from './agent-runtime/agent-runtime.module';
import { MessageLoopModule } from './message-loop/message-loop.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    ConfigModule,
    StaffModule,
    ConnectionsModule,
    AgentRuntimeModule,
    MessageLoopModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
