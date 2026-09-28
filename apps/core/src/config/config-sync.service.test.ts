import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PrismaClient } from '../generated/staff';
import { StaffService } from '../staff/staff.service';
import { ConfigSyncService } from './config-sync.service';

const YAML_G1 = 'name: 真人甲\ntype: HUMAN\n';
const YAML_G2 = 'name: 真人乙\ntype: HUMAN\n';
const YAML_A1 = 'name: 小助\ntype: DIGITAL\nguardian: g1\n';

describe('配置 reconcile 容错（坏 YAML 不得删员工）', () => {
  let dir: string;
  let configDir: string;
  let prisma: PrismaClient;
  let sync: ConfigSyncService;
  let audits: Array<{ action: string; target: string; detail: unknown }>;

  const write = (file: string, body: string) => writeFileSync(join(configDir, file), body);
  const employees = async () =>
    (await prisma.employee.findMany({ orderBy: { configKey: 'asc' } })).map((e) => e.configKey);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aistaff-cfg-'));
    configDir = join(dir, 'config');
    mkdirSync(configDir, { recursive: true });
    process.env.AISTAFF_CONFIG_DIR = configDir;
    process.env.AISTAFF_DATA_DIR = join(dir, 'data');
    const url = `file:${join(dir, 'staff.db')}`;
    execFileSync('npx', ['prisma', 'db', 'push', '--schema', 'prisma/staff.prisma', '--skip-generate'], {
      cwd: join(__dirname, '..', '..'),
      env: { ...process.env, AISTAFF_STAFF_DATABASE_URL: url },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasourceUrl: url });
    audits = [];
    const auditLike = {
      record: async (e: { action: string; target: string; detail: unknown }) => {
        audits.push(e);
      },
    } as never;
    sync = new ConfigSyncService(new StaffService({ staff: prisma } as never), auditLike);
    assert.equal(sync.configDir, configDir);
  });

  after(async () => {
    await prisma.$disconnect();
    delete process.env.AISTAFF_CONFIG_DIR;
    delete process.env.AISTAFF_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('正常声明：三名员工落库并留 upsert 审计', async () => {
    write('g1.yaml', YAML_G1);
    write('g2.yaml', YAML_G2);
    write('a1.yaml', YAML_A1);
    await sync.sync();
    assert.deepEqual(await employees(), ['a1', 'g1', 'g2']);
    assert.equal(audits.filter((a) => a.action === 'config.reconcile.upsert').length, 3);
  });

  it('YAML 语法错误：该员工保留、不删绑定，并留 invalid 审计', async () => {
    audits = [];
    write('a1.yaml', 'name: 小助\ntype: DIGITAL\n  guardian: g1\n');
    await sync.sync();
    assert.deepEqual(await employees(), ['a1', 'g1', 'g2'], '解析失败不得删除在职员工');
    const invalid = audits.filter((a) => a.action === 'config.reconcile.invalid');
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].target, 'a1');
    assert.equal(audits.some((a) => a.action === 'config.reconcile.remove'), false);
  });

  it('Schema 校验失败：同样保留并留 invalid 审计', async () => {
    write('a1.yaml', YAML_A1);
    audits = [];
    write('g2.yaml', 'name: 真人乙\ntype: ROBOT\n');
    await sync.sync();
    assert.deepEqual(await employees(), ['a1', 'g1', 'g2']);
    const invalid = audits.filter((a) => a.action === 'config.reconcile.invalid');
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].target, 'g2');
    write('g2.yaml', YAML_G2);
  });

  it('配置目录不可读：全员保留并留 skip 审计', async () => {
    audits = [];
    process.env.AISTAFF_CONFIG_DIR = join(dir, 'missing');
    const missing = new ConfigSyncService(new StaffService({ staff: prisma } as never), {
      record: async (e: { action: string; target: string; detail: unknown }) => {
        audits.push(e);
      },
    } as never);
    await missing.sync();
    assert.deepEqual(await employees(), ['a1', 'g1', 'g2'], '目录不可读时不得清空员工库');
    assert.ok(audits.some((a) => a.action === 'config.reconcile.skip'));
    process.env.AISTAFF_CONFIG_DIR = configDir;
  });

  it('恢复与真删除：修好 YAML 后正常更新，删掉文件才移除员工', async () => {
    audits = [];
    write('a1.yaml', 'name: 小助二\ntype: DIGITAL\nguardian: g1\n');
    await sync.sync();
    const a1 = await prisma.employee.findUniqueOrThrow({ where: { configKey: 'a1' } });
    assert.equal(a1.name, '小助二');
    assert.equal(audits.some((i) => i.action === 'config.reconcile.invalid'), false);

    rmSync(join(configDir, 'g2.yaml'));
    await sync.sync();
    assert.deepEqual(await employees(), ['a1', 'g1']);
    assert.ok(audits.some((i) => i.action === 'config.reconcile.remove' && i.target === 'g2'));
  });
});
