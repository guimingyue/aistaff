import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigSyncService } from './config/config-sync.service';

@Controller()
export class AppController {
  constructor(@Inject(ConfigSyncService) private readonly configSync: ConfigSyncService) {}

  @Get('health')
  health() {
    return { status: 'ok', configDir: this.configSync.configDir };
  }
}
