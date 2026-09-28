import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/staff';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeConfig } from '../config/employee-config.schema';

export interface SyncResult {
  removed: string[];
  rejected: Array<{ configKey: string; reason: string }>;
}

export interface SyncOptions {
  /** 声明文件存在但解析/校验失败：这些 key 仍算“已声明”，禁止当作孤儿删除。 */
  protectKeys?: readonly string[];
  /** 配置目录整体不可读：本轮跳过删除，避免把全量员工误判为孤儿。 */
  skipRemoval?: boolean;
}

type StaffTx = Prisma.TransactionClient;

const TRANSITIONS: Record<string, string[]> = {
  ACTIVE: ['SUSPENDED', 'OFFBOARDED'],
  SUSPENDED: ['ACTIVE', 'OFFBOARDED'],
  OFFBOARDED: [],
};

export function formatEmployeeNo(type: 'HUMAN' | 'DIGITAL', seq: number): string {
  const n = String(seq).padStart(6, '0');
  return type === 'DIGITAL' ? `AI${n}` : n;
}

async function nextSequence(tx: StaffTx, name: 'DIGITAL' | 'HUMAN'): Promise<number> {
  await tx.sequence.upsert({
    where: { name },
    create: { name, value: 1 },
    update: { value: { increment: 1 } },
  });
  const row = await tx.sequence.findUnique({ where: { name } });
  return row!.value;
}

@Injectable()
export class StaffService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * 以声明集为期望状态同步 staff 库。
   * 两阶段：HUMAN 先落库发号，DIGITAL 后落库（guardian 必须解析为在职真人）。
   * 工号一经发放永不变更；缺失时补挂；guardian 校验失败或类型冲突的声明进入 rejected。
   * 解析失败的声明文件不等于“撤销声明”：由 opts.protectKeys / opts.skipRemoval 挡住误删。
   */
  async syncFromConfigs(
    declared: Map<string, EmployeeConfig>,
    opts: SyncOptions = {},
  ): Promise<SyncResult> {
    return this.prisma.staff.$transaction(async (tx) => {
      const rejected: SyncResult['rejected'] = [];

      const sorted = [...declared.entries()].sort(([, a], [, b]) => {
        const rank = (t: string) => (t === 'HUMAN' ? 0 : 1);
        return rank(a.type) - rank(b.type);
      });

      for (const [configKey, cfg] of sorted) {
        const existing = await tx.employee.findUnique({ where: { configKey } });

        if (existing && cfg.type !== existing.type) {
          rejected.push({ configKey, reason: `cannot change employee type ${existing.type} -> ${cfg.type} (type is bound to the issued employeeNo)` });
          continue;
        }

        let guardianEmployeeNo: string | null = null;
        if (cfg.type === 'DIGITAL') {
          if (!cfg.guardian) {
            rejected.push({ configKey, reason: 'a digital employee must declare a guardian' });
            continue;
          }
          const guardian = await tx.employee.findUnique({ where: { configKey: cfg.guardian } });
          if (!guardian) {
            rejected.push({ configKey, reason: `guardian ${cfg.guardian} not found in employee declarations` });
            continue;
          }
          if (guardian.type !== 'HUMAN') {
            rejected.push({ configKey, reason: `guardian ${cfg.guardian} is not a human employee` });
            continue;
          }
          if (guardian.status !== 'ACTIVE') {
            rejected.push({ configKey, reason: `guardian ${cfg.guardian} is not ACTIVE (${guardian.status})` });
            continue;
          }
          if (guardian.employeeNo === null) {
            rejected.push({ configKey, reason: `guardian ${cfg.guardian} has not been assigned an employee number yet` });
            continue;
          }
          guardianEmployeeNo = guardian.employeeNo;
        }

        const employeeNo = existing?.employeeNo ?? (await issueNo(tx, cfg.type));

        const employee = await tx.employee.upsert({
          where: { configKey },
          create: {
            configKey,
            employeeNo,
            name: cfg.name,
            type: cfg.type,
            dept: cfg.dept,
            reportsTo: cfg.reportsTo,
            guardianEmployeeNo,
          },
          update: {
            employeeNo,
            name: cfg.name,
            type: cfg.type,
            dept: cfg.dept,
            reportsTo: cfg.reportsTo,
            guardianEmployeeNo,
          },
        });

        for (const binding of cfg.bindings ?? []) {
          const existingBinding = await tx.externalBinding.findUnique({
            where: { employeeId_provider: { employeeId: employee.id, provider: binding.provider } },
          });
          // M3 纪律：BOUND 只能由 connection.bind 的只读校验产生；
          // 声明预填一律 PENDING，已绑定账号的 externalUserId 变更则降级回 PENDING。
          const prefilledBindingStatus =
            existingBinding?.bindingStatus === 'BOUND' &&
              existingBinding.externalUserId !== binding.externalUserId
              ? 'PENDING'
              : (existingBinding?.bindingStatus ?? 'PENDING');
          await tx.externalBinding.upsert({
            where: { employeeId_provider: { employeeId: employee.id, provider: binding.provider } },
            create: {
              employeeId: employee.id,
              provider: binding.provider,
              externalUserId: binding.externalUserId,
              bindingStatus: 'PENDING',
            },
            update: {
              externalUserId: binding.externalUserId,
              bindingStatus: prefilledBindingStatus,
            },
          });
        }

        if (cfg.agentProfile) {
          await tx.agentProfile.upsert({
            where: { employeeId: employee.id },
            create: {
              employeeId: employee.id,
              systemPrompt: cfg.agentProfile.systemPrompt,
              model: cfg.agentProfile.model,
              tools: cfg.agentProfile.tools ? JSON.stringify(cfg.agentProfile.tools) : null,
            },
            update: {
              systemPrompt: cfg.agentProfile.systemPrompt,
              model: cfg.agentProfile.model,
              tools: cfg.agentProfile.tools ? JSON.stringify(cfg.agentProfile.tools) : null,
            },
          });
        }
      }

      const removed: string[] = [];
      if (opts.skipRemoval) {
        return { removed, rejected };
      }
      const declaredKeys = [...declared.keys(), ...(opts.protectKeys ?? [])];
      const orphans = await tx.employee.findMany({
        where: declaredKeys.length ? { configKey: { notIn: declaredKeys } } : {},
        select: { id: true, configKey: true, employeeNo: true },
      });
      for (const orphan of orphans) {
        if (orphan.employeeNo) {
          const wards = await tx.employee.count({
            where: { guardianEmployeeNo: orphan.employeeNo, status: { not: 'OFFBOARDED' } },
          });
          if (wards > 0) {
            rejected.push({
              configKey: orphan.configKey,
              reason: `still the guardian of ${wards} digital employee(s); removal forbidden until guardians are reassigned`,
            });
            continue;
          }
        }
        await tx.externalBinding.deleteMany({ where: { employeeId: orphan.id } });
        await tx.agentProfile.deleteMany({ where: { employeeId: orphan.id } });
        await tx.employee.delete({ where: { id: orphan.id } });
        removed.push(orphan.configKey);
      }
      return { removed, rejected };
    });
  }

  /**
   * 状态机迁移：ACTIVE ⇄ SUSPENDED，二者均可 → OFFBOARDED（终态）。
   * 真人离职时若仍是有效数字员工的 guardian 则拒绝。工号永久保留、永不复用。
   */
  async changeStatus(employeeNo: string, to: string): Promise<{ employeeNo: string; status: string }> {
    if (!(to in TRANSITIONS)) {
      throw new Error(`unknown status ${to}`);
    }
    return this.prisma.staff.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({ where: { employeeNo } });
      if (!employee) throw new Error(`employee ${employeeNo} does not exist`);
      if (!TRANSITIONS[employee.status]?.includes(to)) {
        throw new Error(`disallowed status transition ${employee.status} -> ${to}`);
      }
      if (to === 'OFFBOARDED' && employee.type === 'HUMAN') {
        const wards = await tx.employee.count({
          where: { guardianEmployeeNo: employeeNo, status: { not: 'OFFBOARDED' } },
        });
        if (wards > 0) {
          throw new Error(`${employeeNo} is still the guardian of ${wards} digital employee(s); reassign guardians before offboarding`);
        }
      }
      const updated = await tx.employee.update({ where: { id: employee.id }, data: { status: to } });
      return { employeeNo: updated.employeeNo!, status: updated.status };
    });
  }

  list() {
    return this.prisma.staff.employee.findMany({
      include: { bindings: true, agentProfile: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}

async function issueNo(tx: StaffTx, type: 'HUMAN' | 'DIGITAL'): Promise<string> {
  return formatEmployeeNo(type, await nextSequence(tx, type));
}
