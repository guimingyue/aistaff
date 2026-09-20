#!/usr/bin/env tsx
import { Command } from 'commander';
import { coreRequest } from './http';

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
