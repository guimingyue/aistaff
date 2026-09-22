import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PrismaClient } from '../generated/staff';
import { ConnectionsService } from './connections.service';
import { DingtalkAdapter, isolatedEnv } from './dingtalk.adapter';
import { StaffService } from '../staff/staff.service';
import type { EmployeeConfig } from '../config/employee-config.schema';

const FAKE_BIN = join(__dirname, 'testing', 'fake-dws.mjs');

function human(name = '真人'): EmployeeConfig {
  return { name, type: 'HUMAN' } as EmployeeConfig;
}

describe('connections 绑定校验（假 CLI + 真实 SQLite）', () => {
  let dir: string;
  let prisma: PrismaClient;
  let staff: StaffService;
  let connections: ConnectionsService;
  let audits: Array<{ action: string; target: string; detail: unknown }> = [];
  const fakeState = {
    auth: '0',
    users: {} as Record<string, string>,
    argvOut: '',
    envOut: '',
  };
  let employeeId: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aistaff-m3-'));
    process.env.AISTAFF_DATA_DIR = join(dir, 'data');
    const url = `file:${join(dir, 'staff.db')}`;
    execFileSync('npx', ['prisma', 'db', 'push', '--schema', 'prisma/staff.prisma', '--skip-generate'], {
      cwd: join(__dirname, '..', '..'),
      env: { ...process.env, AISTAFF_STAFF_DATABASE_URL: url },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasourceUrl: url });
    staff = new StaffService({ staff: prisma } as never);
    audits = [];
    const auditLike = {
      record: async (e: { action: string; target: string; detail: unknown }) => {
        audits.push(e);
      },
    } as never;
    const factories = {
      DINGTALK: (profileDir: string) =>
        new DingtalkAdapter(
          FAKE_BIN,
          isolatedEnv(profileDir, {
            FAKE_AUTH: fakeState.auth,
            FAKE_USERS: JSON.stringify(fakeState.users),
            FAKE_ARGV_OUT: fakeState.argvOut,
            FAKE_ENV_OUT: fakeState.envOut,
          }),
        ),
    };
    connections = new ConnectionsService({ staff: prisma } as never, auditLike, factories as never);

    await staff.syncFromConfigs(new Map([['g1', human()]]));
    const g = await prisma.employee.findUnique({ where: { configKey: 'g1' } });
    employeeId = g!.id;
  });

  after(async () => {
    await prisma.$disconnect();
    delete process.env.AISTAFF_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const binding = async () =>
    prisma.externalBinding.findFirst({ where: { employeeId, provider: 'DINGTALK' } });

  function lastArgvLines(): string[][] {
    return readFileSync(fakeState.argvOut, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  }

  it('未登录：bind 被拒并留审计，不落 BOUND', async () => {
    fakeState.auth = '0';
    fakeState.argvOut = join(dir, 'argv.log');
    await assert.rejects(
      () => connections.bind({ employeeNo: '000001', provider: 'DINGTALK', externalUserId: 'u1' }, 'tester'),
      /未登录/,
    );
    assert.ok(audits.some((a) => a.action === 'connection.bind.reject' && a.target === '000001/DINGTALK'));
    assert.equal(await binding(), null);
  });

  it('账号不存在：回填 externalUserId 但保持 PENDING', async () => {
    fakeState.auth = '1';
    fakeState.users = {};
    await assert.rejects(
      () => connections.bind({ employeeNo: '000001', provider: 'DINGTALK', externalUserId: 'ghost' }, 'tester'),
      /不存在/,
    );
    const b = await binding();
    assert.equal(b!.bindingStatus, 'PENDING');
    assert.equal(b!.externalUserId, 'ghost');
  });

  it('姓名不匹配：拒绝且留双方姓名审计', async () => {
    fakeState.users = { ghost2: '别人' };
    await assert.rejects(
      () => connections.bind({ employeeNo: '000001', provider: 'DINGTALK', externalUserId: 'ghost2' }, 'tester'),
      /「真人」与三方账号姓名「别人」/,
    );
    assert.ok(audits.some((a) => /姓名不匹配/.test(JSON.stringify(a.detail))));
  });

  it('姓名匹配：BOUND 且写入 cliProfileDir 与审计', async () => {
    fakeState.users = { ghost2: '真人' };
    fakeState.envOut = join(dir, 'env.json');
    const r = await connections.bind(
      { employeeNo: '000001', provider: 'DINGTALK', externalUserId: 'ghost2' },
      'tester',
    );
    assert.equal(r.bindingStatus, 'BOUND');
    assert.equal(r.verifiedName, '真人');
    const b = await binding();
    assert.equal(b!.bindingStatus, 'BOUND');
    assert.ok(b!.cliProfileDir?.includes('000001-DINGTALK'));
    assert.ok(audits.some((a) => a.action === 'connection.bind'));

    const env = JSON.parse(readFileSync(fakeState.envOut, 'utf8'));
    assert.ok(env.HOME.endsWith('000001-DINGTALK'));
    assert.ok(env.DWS_CONFIG_DIR.startsWith(env.HOME));
    assert.ok(env.XDG_CONFIG_HOME.startsWith(env.HOME));
  });

  it('argv 注入防线：含 shell 元字符的 ID 原样单参数传递，不产生文件副作用', async () => {
    fakeState.auth = '1';
    fakeState.users = {};
    fakeState.argvOut = join(dir, 'argv-inject.log');
    const evil = String.raw`x" && touch ${join(dir, 'pwned')} #`;
    await assert.rejects(
      () => connections.bind({ employeeNo: '000001', provider: 'DINGTALK', externalUserId: evil }, 'tester'),
      /不存在/,
    );
    const argvs = lastArgvLines();
    const contactCall = argvs.find((a) => a[0] === 'contact');
    assert.ok(contactCall);
    assert.ok(contactCall.includes(evil), 'evil id 必须原样作为单个 argv token');
    assert.equal(existsSync(join(dir, 'pwned')), false);
  });

  it('login 托管：exitCode 返回并审计', async () => {
    fakeState.auth = '0';
    const r = await connections.login('000001', 'DINGTALK', 'tester');
    assert.equal(r.exitCode, 0);
    assert.ok(audits.some((a) => a.action === 'connection.login' && a.target === '000001/DINGTALK'));
  });

  it('reconcile 绑定语义：预填 PENDING；BOUND 后 externalUserId 变更降级、不变保留', async () => {
    const declared = (ext?: string) =>
      new Map<string, EmployeeConfig>([
        [
          'g1',
          { name: '真人', type: 'HUMAN', bindings: [{ provider: 'DINGTALK', externalUserId: ext }] } as EmployeeConfig,
        ],
      ]);

    await staff.syncFromConfigs(declared('prefill-1'));
    let b = await binding();
    assert.equal(b!.bindingStatus, 'PENDING', '声明预填不得直接 BOUND');

    await prisma.externalBinding.update({
      where: { id: b!.id },
      data: { bindingStatus: 'BOUND' },
    });
    await staff.syncFromConfigs(declared('prefill-1'));
    b = await binding();
    assert.equal(b!.bindingStatus, 'BOUND', '无变化的 reconcile 不应降级');

    await staff.syncFromConfigs(declared('prefill-2'));
    b = await binding();
    assert.equal(b!.bindingStatus, 'PENDING', 'externalUserId 变更必须降级重验');
  });

  it('飞书通道：显式失败不静默', async () => {
    await assert.rejects(
      () => connections.bind({ employeeNo: '000001', provider: 'FEISHU', externalUserId: 'x' }, 'tester'),
      /二期/,
    );
  });
});
