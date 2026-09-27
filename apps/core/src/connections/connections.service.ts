import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DirectoryAdapter } from './directory-adapter';
import { FeishuAdapter } from './feishu.adapter';
import { dingtalkAdapterFactory } from './dingtalk.adapter';

export type AdapterFactory = (profileDir: string) => DirectoryAdapter;

export const ADAPTER_FACTORIES = Symbol('ADAPTER_FACTORIES');

export interface BindRequest {
  provider: 'DINGTALK' | 'FEISHU';
  externalUserId: string;
}

export interface BindResult {
  employeeNo: string;
  provider: string;
  externalUserId: string;
  bindingStatus: string;
  verifiedName?: string;
}

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ADAPTER_FACTORIES)
    private readonly factories: Partial<Record<'DINGTALK' | 'FEISHU', AdapterFactory>>,
  ) {}

  private dataDir(): string {
    return process.env.AISTAFF_DATA_DIR ?? resolve(process.cwd(), '..', '..', 'data');
  }

  profileDir(employeeNo: string, provider: string): string {
    return resolve(this.dataDir(), 'cli-profiles', `${employeeNo}-${provider}`);
  }

  private adapter(provider: string, employeeNo: string): DirectoryAdapter {
    if (provider === 'DINGTALK') {
      return (this.factories.DINGTALK ?? dingtalkAdapterFactory('dws'))(
        this.profileDir(employeeNo, provider),
      );
    }
    if (provider === 'FEISHU') {
      const f = this.factories.FEISHU;
      if (f) return f(this.profileDir(employeeNo, provider));
      return new FeishuAdapter();
    }
    throw new Error(`unknown provider ${provider}`);
  }

  private async requireEmployee(employeeNo: string) {
    const employee = await this.prisma.staff.employee.findUnique({
      where: { employeeNo },
      include: { bindings: true },
    });
    if (!employee) throw new Error(`employee ${employeeNo} does not exist`);
    return employee;
  }

  /** CLI 登录托管：登录态落在该员工专属 profile 目录，平台不读取 token。 */
  async login(employeeNo: string, provider: string, actor: string, orgProfile?: string) {
    const employee = await this.requireEmployee(employeeNo);
    if (employee.status === 'OFFBOARDED') {
      throw new Error(`employee ${employeeNo} is offboarded; login is not allowed`);
    }
    const adapter = this.adapter(provider, employeeNo);
    const exitCode = await adapter.loginInteractive(orgProfile);
    await this.audit.record({
      actor,
      action: 'connection.login',
      target: `${employeeNo}/${provider}`,
      detail: { exitCode, profileDir: this.profileDir(employeeNo, provider), orgProfile },
    });
    return { employeeNo, provider, exitCode };
  }

  /**
   * 预填绑定 + 只读校验（设计文档 §5.2）：
   * CLI 通讯录查 externalUserId → 存在且姓名与员工声明一致才 BOUND；否则留 PENDING 并记拒绝审计。
   */
  async bind(req: BindRequest & { employeeNo: string }, actor: string): Promise<BindResult> {
    const { employeeNo, provider, externalUserId } = req;
    const employee = await this.requireEmployee(employeeNo);
    if (employee.status === 'OFFBOARDED') {
      throw new Error(`employee ${employeeNo} is offboarded; binding is not allowed`);
    }
    const adapter = this.adapter(provider, employeeNo);

    const status = await adapter.authStatus();
    if (!status.authenticated) {
      await this.auditReject(employeeNo, provider, externalUserId, actor, 'CLI profile not logged in');
      throw new Error(
        `employee ${employeeNo}: ${provider} CLI profile is not logged in; run "aistaff login ${employeeNo} --provider ${provider}" first`,
      );
    }

    const user = await adapter.verifyUser(externalUserId);
    const bindingData = {
      where: { employeeId_provider: { employeeId: employee.id, provider } },
    };

    if (!user) {
      await this.prisma.staff.externalBinding.upsert({
        ...bindingData,
        create: { employeeId: employee.id, provider, externalUserId, bindingStatus: 'PENDING' },
        update: { externalUserId, bindingStatus: 'PENDING' },
      });
      await this.auditReject(employeeNo, provider, externalUserId, actor, 'account not found in third-party directory');
      throw new Error(`verification failed: account ${externalUserId} not found in ${provider} directory`);
    }

    if (user.name !== employee.name) {
      await this.prisma.staff.externalBinding.upsert({
        ...bindingData,
        create: { employeeId: employee.id, provider, externalUserId, bindingStatus: 'PENDING' },
        update: { externalUserId, bindingStatus: 'PENDING' },
      });
      await this.auditReject(
        employeeNo,
        provider,
        externalUserId,
        actor,
        `name mismatch (declared "${employee.name}" != third-party "${user.name}")`,
      );
      throw new Error(
        `verification failed: declared name "${employee.name}" does not match third-party name "${user.name}"`,
      );
    }

    const binding = await this.prisma.staff.externalBinding.upsert({
      ...bindingData,
      create: {
        employeeId: employee.id,
        provider,
        externalUserId,
        bindingStatus: 'BOUND',
        cliProfileDir: this.profileDir(employeeNo, provider),
      },
      update: {
        externalUserId,
        bindingStatus: 'BOUND',
        cliProfileDir: this.profileDir(employeeNo, provider),
      },
    });
    await this.audit.record({
      actor,
      action: 'connection.bind',
      target: `${employeeNo}/${provider}`,
      detail: { externalUserId, verifiedName: user.name },
    });
    return {
      employeeNo,
      provider,
      externalUserId: binding.externalUserId ?? externalUserId,
      bindingStatus: binding.bindingStatus,
      verifiedName: user.name,
    };
  }

  private auditReject(
    employeeNo: string,
    provider: string,
    externalUserId: string,
    actor: string,
    reason: string,
  ) {
    return this.audit.record({
      actor,
      action: 'connection.bind.reject',
      target: `${employeeNo}/${provider}`,
      detail: { externalUserId, reason },
    });
  }

  /** 绑定 + 登录态观测（只读，同样记审计：每次 CLI 调用必记审计）。 */
  async status(employeeNo: string, provider?: string, actor = 'admin-cli') {
    const employee = await this.requireEmployee(employeeNo);
    const bindings = provider
      ? employee.bindings.filter((b) => b.provider === provider)
      : employee.bindings;
    const results = [];
    for (const b of bindings) {
      let auth: { authenticated: boolean } | { error: string };
      try {
        auth = { authenticated: (await this.adapter(b.provider, employeeNo).authStatus()).authenticated };
      } catch (err) {
        auth = { error: (err as Error).message };
      }
      results.push({
        provider: b.provider,
        externalUserId: b.externalUserId,
        bindingStatus: b.bindingStatus,
        cliProfileDir: this.profileDir(employeeNo, b.provider),
        auth,
      });
    }
    await this.audit.record({
      actor,
      action: 'connection.status',
      target: `${employeeNo}/${provider ?? '*'}`,
      detail: { providers: results.map((r) => r.provider) },
    });
    return { employeeNo, name: employee.name, status: employee.status, bindings: results };
  }
}
