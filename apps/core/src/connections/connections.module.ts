import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ConnectionsController } from './connections.controller';
import { ADAPTER_FACTORIES, ConnectionsService } from './connections.service';
import { dingtalkAdapterFactory } from './dingtalk.adapter';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ConnectionsController],
  providers: [
    ConnectionsService,
    {
      provide: ADAPTER_FACTORIES,
      useValue: {
        DINGTALK: dingtalkAdapterFactory(process.env.AISTAFF_DWS_BIN ?? 'dws'),
      },
    },
  ],
})
export class ConnectionsModule {}
