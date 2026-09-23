# aistaff 数字员工平台（一期 MVP）

设计见 `docs/design.md`。monorepo：`apps/core`（NestJS 常驻服务 + SQLite 三库）、`apps/cli`（`aistaff` 管理命令行）、`config/`（员工 YAML 声明）、`scripts/`（各里程碑验证）。

## 前置条件

- Node ≥ 22、pnpm 10（`allowBuilds` 需放行 prisma/esbuild 构建脚本，已配在 `pnpm-workspace.yaml`）
- 钉钉侧真实链路需官方 CLI `dws` 在 PATH（验证于 v1.0.54；用到 `auth status/login --device`、`contact user get/get-self`、`chat message send`、`event consume user_im_message_receive_at --flatten`）
- 真实模型回复需 `AISTAFF_MODEL_API_KEY`（配套 `AISTAFF_MODEL_PROVIDER`，缺省 anthropic）；不设置时可用 `AISTAFF_AGENT_RUNNER=echo` 桩走通除模型产出的全链路
- 慢网装依赖：pnpm 已配 npmmirror 源；ETag 续传策略见 lockfile，无需额外操作

## 启动

```bash
pnpm install
pnpm --filter @aistaff/core run db:push   # Prisma 三库（staff/sessions/audit，文件在 data/）
(cd apps/core && pnpm start)              # core 监听 http://127.0.0.1:3000
```

core 启动即 reconcile `config/*.yaml`（员工建档/发号/状态收敛），所有操作可经 CLI 观测：

```bash
cd apps/cli && pnpm exec tsx src/main.ts <command>
```

| 命令 | 作用 |
|---|---|
| `health` / `employees list` / `employee <start\|stop\|offboard> <工号>` | 身份与状态机（工号唯一/不变/离职不复用） |
| `login <工号>` / `bind <工号> --provider DINGTALK --external-user-id <id>` / `connection <工号>` | CLI 登录托管（每员工隔离 profile `data/cli-profiles/<工号>-DINGTALK`）+ 只读校验绑定 |
| `chat <工号> <消息...> [-c 会话id]` / `conversations <工号>` | pi-coding-agent 员工实例对话，会话持久化 sessions.db |
| `listen <工号> [--stop]` / `loops` | 钉钉 @消息闭环：订阅→路由 Agent→自动回发（优雅停机 SIGTERM） |
| `audit -n <条数>` | 追加写审计（状态/绑定/CLI/消息全链路） |

关键环境变量（core 进程）：`AISTAFF_DATA_DIR`（默认 `data/`）、`AISTAFF_AGENT_RUNNER=echo`、`AISTAFF_MODEL_API_KEY`、`AISTAFF_MODEL_PROVIDER`、`AISTAFF_DWS_BIN`（替换 dws 可执行文件，测试假 CLI 用）。

## 验证

自动化（无外部依赖，假 dws + echo 桩）：

```bash
bash scripts/verify-m1.sh && bash scripts/verify-m2.sh \
  && bash scripts/verify-m3.sh && bash scripts/verify-m4.sh && bash scripts/verify-m5.sh
pnpm --filter @aistaff/core test
```

真实链路（需人工配合，按需运行）：

已对真实 dws v1.0.54 完成契约核验（无需授权即可验证的部分）：`event schema user_im_message_receive_at --flatten` 字段与通道解析一一对应（type 恒为事件键、event_id 去重、sender_open_dingtalk_id 等）；`chat message send` argv 面 `--mock` 通过；未登录 profile 上 `event consume` 以 exit 5 + stderr JSON 错误明确退出（诊断会进 loop 审计）；设备授权链接格式与 live 脚本正则匹配。

- `bash scripts/verify-m3-live.sh` — 真实钉钉设备授权 + 只读校验绑定（手机钉钉确认授权链接）
- `bash scripts/verify-m5-live.sh` — Golden Path：小助 profile 登录后 `listen`，同事群内 @小助 收自动回复；设 `AISTAFF_MODEL_API_KEY` 则走真模型，否则 echo 桩并明示降级
- 真实模型对话：设置 Key 后重跑 `verify-m4.sh` step 6（PROBE_BLOCKED → PROBE_OK）
