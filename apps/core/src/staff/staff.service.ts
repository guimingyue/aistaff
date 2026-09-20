import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeConfig } from '../config/employee-config.schema';

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 以声明集为期望状态同步 staff 库，返回被移除的 configKey。
   * 工号（employeeNo）一期为 null，由 M2 发号器补挂。
   */
  async syncFromConfigs(declared: Map<string, EmployeeConfig>): Promise<string[]> {
    return this.prisma.staff.$transaction(async (tx) => {
      for (const [configKey, cfg] of declared) {
        const employee = await tx.employee.upsert({
          where: { configKey },
          create: {
            configKey,
            name: cfg.name,
            type: cfg.type,
            dept: cfg.dept,
            reportsTo: cfg.reportsTo,
            guardianEmployeeNo: cfg.guardian,
          },
          update: {
            name: cfg.name,
            type: cfg.type,
            dept: cfg.dept,
            reportsTo: cfg.reportsTo,
            guardianEmployeeNo: cfg.guardian,
          },
        });

        for (const binding of cfg.bindings ?? []) {
          await tx.externalBinding.upsert({
            where: { employeeId_provider: { employeeId: employee.id, provider: binding.provider } },
            create: {
              employeeId: employee.id,
              provider: binding.provider,
              externalUserId: binding.externalUserId,
              bindingStatus: binding.externalUserId ? 'BOUND' : 'PENDING',
            },
            update: {
              externalUserId: binding.externalUserId,
              bindingStatus: binding.externalUserId ? 'BOUND' : 'PENDING',
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

      const keys = [...declared.keys()];
      const orphans = await tx.employee.findMany({
        where: keys.length ? { configKey: { notIn: keys } } : {},
        select: { id: true, configKey: true },
      });
      for (const orphan of orphans) {
        await tx.externalBinding.deleteMany({ where: { employeeId: orphan.id } });
        await tx.agentProfile.deleteMany({ where: { employeeId: orphan.id } });
        await tx.employee.delete({ where: { id: orphan.id } });
      }
      return orphans.map((o) => o.configKey);
    });
  }

  list() {
    return this.prisma.staff.employee.findMany({
      include: { bindings: true, agentProfile: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
