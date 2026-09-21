import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PrismaClient } from '../generated/staff';
import { StaffService, formatEmployeeNo } from './staff.service';
import type { EmployeeConfig } from '../config/employee-config.schema';

function human(overrides: Partial<EmployeeConfig> = {}): EmployeeConfig {
  return { name: '真人', type: 'HUMAN', ...overrides } as EmployeeConfig;
}

function digital(guardian: string, overrides: Partial<EmployeeConfig> = {}): EmployeeConfig {
  return { name: '数字', type: 'DIGITAL', guardian, ...overrides } as EmployeeConfig;
}

function config(keys: Record<string, EmployeeConfig>): Map<string, EmployeeConfig> {
  return new Map(Object.entries(keys));
}

describe('工号规则', () => {
  it('格式：DIGITAL=AI+6位零填充，HUMAN=6位零填充', () => {
    assert.equal(formatEmployeeNo('DIGITAL', 1), 'AI000001');
    assert.equal(formatEmployeeNo('DIGITAL', 2026), 'AI002026');
    assert.equal(formatEmployeeNo('HUMAN', 7), '000007');
  });
});

describe('发号器与不变式（真实 SQLite）', () => {
  let dir: string;
  let prisma: PrismaClient;
  let staff: StaffService;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'aistaff-m2-'));
    const url = `file:${join(dir, 'staff.db')}`;
    execFileSync('npx', ['prisma', 'db', 'push', '--schema', 'prisma/staff.prisma', '--skip-generate'], {
      cwd: join(__dirname, '..', '..'),
      env: { ...process.env, AISTAFF_STAFF_DATABASE_URL: url },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasourceUrl: url });
    staff = new StaffService({ staff: prisma } as never);
  });

  after(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = (): Record<string, EmployeeConfig> => ({
    g1: human(),
    g2: human(),
    a1: digital('g1'),
    a2: digital('g1'),
  });

  const withA3 = (): Record<string, EmployeeConfig> => ({ ...base(), a3: digital('g1') });

  it('双序列独立递增', async () => {
    const result = await staff.syncFromConfigs(config(base()));
    assert.deepEqual(result.rejected, []);
    const byKey = Object.fromEntries(
      (await prisma.employee.findMany()).map((e) => [e.configKey, e.employeeNo]),
    );
    assert.equal(byKey.g1, '000001');
    assert.equal(byKey.g2, '000002');
    assert.equal(byKey.a1, 'AI000001');
    assert.equal(byKey.a2, 'AI000002');
  });

  it('reconcile 更新不变更工号', async () => {
    await staff.syncFromConfigs(
      config({ ...base(), a1: digital('g1', { name: '改名' }) }),
    );
    const e = await prisma.employee.findUnique({ where: { configKey: 'a1' } });
    assert.equal(e!.employeeNo, 'AI000001');
    assert.equal(e!.name, '改名');
  });

  it('离职后工号不复用：下一个数字员工拿新号，reconcile 不回写状态', async () => {
    await staff.changeStatus('AI000002', 'OFFBOARDED');
    await staff.syncFromConfigs(config({ ...base(), a3: digital('g1') }));
    const a3 = await prisma.employee.findUnique({ where: { configKey: 'a3' } });
    assert.equal(a3!.employeeNo, 'AI000003');
    const a2 = await prisma.employee.findUnique({ where: { configKey: 'a2' } });
    assert.equal(a2!.status, 'OFFBOARDED');
  });

  it('补挂遗留的 employeeNo=null', async () => {
    await prisma.employee.create({
      data: { configKey: 'legacy', type: 'HUMAN', name: '遗留' },
    });
    const result = await staff.syncFromConfigs(
      config({ ...base(), a3: digital('g1'), legacy: human() }),
    );
    assert.deepEqual(result.rejected, []);
    const legacy = await prisma.employee.findUnique({ where: { configKey: 'legacy' } });
    assert.equal(legacy!.employeeNo, '000003');
  });

  it('guardian 校验：未声明/非在职/非真人均拒绝且不落库', async () => {
    const missing = await staff.syncFromConfigs(
      config({ ...withA3(), bad1: digital('nobody') }),
    );
    assert.equal(
      missing.rejected.find((r) => r.configKey === 'bad1')?.reason,
      'guardian nobody 未在员工声明中找到',
    );
    assert.equal(await prisma.employee.count({ where: { configKey: 'bad1' } }), 0);

    // 模拟 guardian 离职（绕开 changeStatus 的 guardian 保护，直改库）
    await prisma.employee.update({
      where: { configKey: 'g1' },
      data: { status: 'OFFBOARDED' },
    });
    const inactive = await staff.syncFromConfigs(
      config({ ...withA3(), bad2: digital('g1') }),
    );
    assert.match(
      inactive.rejected.find((r) => r.configKey === 'bad2')!.reason,
      /非在职/,
    );
    assert.equal(await prisma.employee.count({ where: { configKey: 'bad2' } }), 0);
    await prisma.employee.update({
      where: { configKey: 'g1' },
      data: { status: 'ACTIVE' },
    });

    const wrongType = await staff.syncFromConfigs(
      config({ ...withA3(), bad3: digital('a1') }),
    );
    assert.match(
      wrongType.rejected.find((r) => r.configKey === 'bad3')!.reason,
      /不是真人/,
    );
    assert.equal(await prisma.employee.count({ where: { configKey: 'bad3' } }), 0);
  });

  it('真人 guardian 仍有在职数字员工时拒绝离职；移除声明同样被阻止', async () => {
    await assert.rejects(
      () => staff.changeStatus('000001', 'OFFBOARDED'),
      /仍是 \d+ 个数字员工的 guardian/,
    );

    // g1 从声明集中消失 → orphan，但因 guardian 保护不被删除
    const result = await staff.syncFromConfigs(
      config({ g2: human(), a2: digital('g1') }),
    );
    assert.ok(
      result.rejected.some((r) => r.configKey === 'g1' && /guardian/.test(r.reason)),
    );
    assert.equal(await prisma.employee.count({ where: { configKey: 'g1' } }), 1);
  });

  it('状态机：未知状态/终态迁出/不存在 均抛错，ACTIVE⇄SUSPENDED 可用', async () => {
    await assert.rejects(() => staff.changeStatus('000002', 'RETIRED'), /未知状态/);
    await assert.rejects(() => staff.changeStatus('999999', 'ACTIVE'), /不存在/);
    // AI000002 已在前面用例离职，OFFBOARDED 为终态
    await assert.rejects(
      () => staff.changeStatus('AI000002', 'ACTIVE'),
      /不允许的状态迁移 OFFBOARDED/,
    );
    await staff.changeStatus('000002', 'SUSPENDED');
    await staff.changeStatus('000002', 'ACTIVE');
  });
});
