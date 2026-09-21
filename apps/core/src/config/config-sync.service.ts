import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs, watch as fsWatch, type FSWatcher } from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { employeeConfigSchema, EmployeeConfig } from './employee-config.schema';
import { StaffService } from '../staff/staff.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ConfigSyncService implements OnModuleInit, OnModuleDestroy {
  readonly configDir = path.resolve(
    process.env.AISTAFF_CONFIG_DIR ?? path.join(process.cwd(), '..', '..', 'config', 'employees'),
  );

  private readonly logger = new Logger(ConfigSyncService.name);
  private watcher?: FSWatcher;
  private debounce?: NodeJS.Timeout;
  private syncing: Promise<void> = Promise.resolve();

  constructor(
    @Inject(StaffService) private readonly staff: StaffService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    await this.sync();
    await fs.mkdir(this.configDir, { recursive: true });
    this.watcher = fsWatch(this.configDir, { recursive: true }, () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        this.syncing = this.syncing.then(() => this.sync()).catch((err) => this.logger.error(err));
      }, 300);
    });
  }

  onModuleDestroy() {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
  }

  async sync(): Promise<void> {
    const declared = await this.loadConfigs();
    const removed = await this.staff.syncFromConfigs(declared);
    for (const [configKey, cfg] of declared) {
      await this.audit.record({
        actor: 'system',
        action: 'config.reconcile.upsert',
        target: configKey,
        detail: { name: cfg.name, type: cfg.type },
      });
    }
    for (const configKey of removed) {
      await this.audit.record({ actor: 'system', action: 'config.reconcile.remove', target: configKey });
    }
    this.logger.log(`reconcile done: ${declared.size} declared, ${removed.length} removed`);
  }

  private async loadConfigs(): Promise<Map<string, EmployeeConfig>> {
    const result = new Map<string, EmployeeConfig>();
    let files: string[];
    try {
      files = (await fs.readdir(this.configDir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch {
      this.logger.warn(`config dir not found: ${this.configDir}`);
      return result;
    }
    for (const file of files) {
      const configKey = file.replace(/\.ya?ml$/, '');
      try {
        const raw = await fs.readFile(path.join(this.configDir, file), 'utf8');
        result.set(configKey, employeeConfigSchema.parse(YAML.parse(raw)));
      } catch (err) {
        this.logger.error(`invalid config ${file}: ${(err as Error).message}`);
      }
    }
    return result;
  }
}
