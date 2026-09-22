#!/usr/bin/env tsx
import { Command } from 'commander';
import { corePatch, corePost, coreRequest } from './http';

const program = new Command();
program.name('aistaff').description('aistaff 数字员工平台管理命令行').version('0.0.0');

program
  .command('health')
  .description('检查 core 服务健康状态')
  .action(async () => {
    console.log(JSON.stringify(await coreRequest('/health'), null, 2));
  });

program
  .command('employees')
  .description('员工管理')
  .addCommand(
    new Command('list')
      .description('列出员工（来自 staff 库）')
      .action(async () => {
        const employees = await coreRequest<Array<Record<string, unknown>>>('/employees');
        if (employees.length === 0) {
          console.log('（无员工，先在 config/employees/ 下放置 YAML 声明）');
          return;
        }
        for (const e of employees) {
          console.log(
            [
              e.employeeNo ?? '(待发号)',
              e.type,
              e.name,
              e.status,
              `config:${e.configKey}`,
              `bindings:${(e.bindings as Array<{ provider: string; bindingStatus: string }>)
                ?.map((b) => `${b.provider}:${b.bindingStatus}`)
                .join(',') || '-'}`,
              e.agentProfile ? 'agent:yes' : 'agent:no',
            ].join('  '),
          );
        }
      }),
  );

const employee = program.command('employee').description('员工状态操作（按工号）');
for (const [verb, status, desc] of [
  ['start', 'ACTIVE', '启用（SUSPENDED → ACTIVE）'],
  ['stop', 'SUSPENDED', '停用（ACTIVE → SUSPENDED）'],
  ['offboard', 'OFFBOARDED', '离职（终态，工号永久保留）'],
] as const) {
  employee
    .command(verb)
    .argument('<employeeNo>', '工号')
    .description(desc)
    .action(async (employeeNo: string) => {
      const result = await corePatch<{ employeeNo: string; status: string }>(
        `/employees/${encodeURIComponent(employeeNo)}/status`,
        { status },
      );
      console.log(`${result.employeeNo} → ${result.status}`);
    });
}

program
  .command('login')
  .description('托管员工 CLI 登录（登录态存入员工专属 profile 目录）')
  .argument('<employeeNo>', '工号')
  .option('--provider <provider>', 'DINGTALK | FEISHU', 'DINGTALK')
  .action(async (employeeNo: string, opts: { provider: string }) => {
    const result = await corePost<{ exitCode: number }>(
      `/employees/${encodeURIComponent(employeeNo)}/login`,
      { provider: opts.provider },
    );
    console.log(`login exit=${result.exitCode}`);
    process.exitCode = result.exitCode === 0 ? 0 : 1;
  });

program
  .command('bind')
  .description('预填 externalUserId 并经 CLI 只读校验（存在 + 姓名匹配 → BOUND）')
  .argument('<employeeNo>', '工号')
  .requiredOption('--provider <provider>', 'DINGTALK | FEISHU')
  .requiredOption('--external-user-id <id>', '三方通讯录账号 ID')
  .action(
    async (
      employeeNo: string,
      opts: { provider: string; externalUserId: string },
    ) => {
      const r = await corePost<{ bindingStatus: string; verifiedName?: string }>(
        `/employees/${encodeURIComponent(employeeNo)}/bind`,
        { provider: opts.provider, externalUserId: opts.externalUserId },
      );
      console.log(`${employeeNo} ${opts.provider} → ${r.bindingStatus} (三方姓名: ${r.verifiedName})`);
    },
  );

program
  .command('connection')
  .description('查看员工绑定与登录态')
  .argument('<employeeNo>', '工号')
  .option('--provider <provider>', '仅看指定 provider')
  .action(async (employeeNo: string, opts: { provider?: string }) => {
    const q = opts.provider ? `?provider=${encodeURIComponent(opts.provider)}` : '';
    const info = await coreRequest<Record<string, unknown>>(
      `/employees/${encodeURIComponent(employeeNo)}/connections${q}`,
    );
    console.log(JSON.stringify(info, null, 2));
  });

program
  .command('audit')
  .description('查看审计事件（最新在前）')
  .option('-n, --limit <number>', '条数', '20')
  .action(async (opts: { limit: string }) => {
    const events = await coreRequest<Array<Record<string, unknown>>>(
      `/audit-events?limit=${encodeURIComponent(opts.limit)}`,
    );
    for (const ev of events) {
      console.log(`${ev.ts}  ${ev.actor}  ${ev.action}  ${ev.target}  ${ev.detail ?? ''}`);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
