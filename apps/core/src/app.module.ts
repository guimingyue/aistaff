import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { ConfigModule } from './config/config.module';
import { StaffModule } from './staff/staff.module';
import { AppController } from './app.controller';

@Module({
  imports: [PrismaModule, AuditModule, ConfigModule, StaffModule],
  controllers: [AppController],
})
export class AppModule {}
