import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fs, watch as fsWatch, type FSWatcher } from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { employeeConfigSchema, EmployeeConfig } from './employee-config.schema';
import { StaffService } from '../staff/staff.service';
import { AuditService } from '../audit/audit.service';

export interface LoadedConfigs {
  declared: Map<string, EmployeeConfig>;
  /** 文件存在但 YAML/Schema 校验失败：不得据此删除已有员工。 */
  invalid: Array<{ configKey: string; reason: string }>;
  dirAvailable: boolean;
}

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
    const { declared, invalid, dirAvailable } = await this.loadConfigs();
    // 解析失败的声明文件仍算“已声明”，配置目录不可读时整轮不删人：
    // 否则一次手滑的 YAML 语法错误就会把在职员工连同绑定一起清掉。
    const { removed, rejected } = await this.staff.syncFromConfigs(declared, {
      protectKeys: invalid.map((i) => i.configKey),
      skipRemoval: !dirAvailable,
    });
    for (const [configKey, cfg] of declared) {
      await this.audit.record({
        actor: 'system',
        action: 'config.reconcile.upsert',
        target: configKey,
        detail: { name: cfg.name, type: cfg.type },
      });
    }
    for (const i of invalid) {
      await this.audit.record({
        actor: 'system',
        action: 'config.reconcile.invalid',
        target: i.configKey,
        detail: { reason: i.reason },
      });
      this.logger.error(`invalid config ${i.configKey}: ${i.reason} (kept existing employee, removal blocked)`);
    }
    if (!dirAvailable) {
      await this.audit.record({
        actor: 'system',
        action: 'config.reconcile.skip',
        target: this.configDir,
        detail: { reason: 'config directory unreadable; employee removal skipped for this round' },
      });
    }
    for (const configKey of removed) {
      await this.audit.record({ actor: 'system', action: 'config.reconcile.remove', target: configKey });
    }
    for (const r of rejected) {
      await this.audit.record({
        actor: 'system',
        action: 'config.reconcile.reject',
        target: r.configKey,
        detail: { reason: r.reason },
      });
      this.logger.warn(`reject ${r.configKey}: ${r.reason}`);
    }
    this.logger.log(
      `reconcile done: ${declared.size} declared, ${invalid.length} invalid, ${removed.length} removed, ${rejected.length} rejected`,
    );
  }

  private async loadConfigs(): Promise<LoadedConfigs> {
    const declared = new Map<string, EmployeeConfig>();
    const invalid: Array<{ configKey: string; reason: string }> = [];
    let files: string[];
    try {
      files = (await fs.readdir(this.configDir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch (err) {
      this.logger.warn(`config dir not readable: ${this.configDir}: ${(err as Error).message}`);
      return { declared, invalid, dirAvailable: false };
    }
    for (const file of files) {
      const configKey = file.replace(/\.ya?ml$/, '');
      try {
        const raw = await fs.readFile(path.join(this.configDir, file), 'utf8');
        declared.set(configKey, employeeConfigSchema.parse(YAML.parse(raw)));
      } catch (err) {
        invalid.push({ configKey, reason: (err as Error).message.slice(0, 500) });
      }
    }
    return { declared, invalid, dirAvailable: true };
  }
}
