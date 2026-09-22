import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { ConfigModule } from './config/config.module';
import { StaffModule } from './staff/staff.module';
import { ConnectionsModule } from './connections/connections.module';
import { AppController } from './app.controller';

@Module({
  imports: [PrismaModule, AuditModule, ConfigModule, StaffModule, ConnectionsModule],
  controllers: [AppController],
})
export class AppModule {}
