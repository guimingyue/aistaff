import { Module } from '@nestjs/common';
import { ConfigSyncService } from './config-sync.service';
import { StaffModule } from '../staff/staff.module';

@Module({
  imports: [StaffModule],
  providers: [ConfigSyncService],
  exports: [ConfigSyncService],
})
export class ConfigModule {}
