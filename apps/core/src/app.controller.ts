import { Controller, Get } from '@nestjs/common';
import { ConfigSyncService } from './config/config-sync.service';

@Controller()
export class AppController {
  constructor(private readonly configSync: ConfigSyncService) {}

  @Get('health')
  health() {
    return { status: 'ok', configDir: this.configSync.configDir };
  }
}
