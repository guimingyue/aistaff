# aistaff 数字员工平台

aistaff 让 AI 助手以**数字员工**的身份进入企业组织：拥有独立工号和员工账号，与真人员工同构地出现在通讯录与汇报线中，同事可以像对待真人同事一样使用它——在群里 @ 它提问、给它派任务、收到署名它的回复。

数字员工对外使用真实的钉钉账号收发消息，对内由 AI 大脑（基于 [pi coding agent](https://github.com/earendil-works/pi)）生成回复。设计动机与完整方案见 [`docs/design.md`](docs/design.md)。

## 平台特性

- **做认证，不做授权**：平台只回答"你是谁"；能做什么由三方账号自身的权限决定，不建 RBAC、不双写权限数据。
- **真人与数字员工同构**：同一份员工模型；数字员工只是额外挂了 guardian、Agent 配置和独立 workspace。
- **工号权威且永不复用**：数字员工为 `AI` + 6 位序号（如 `AI000001`），真人为 6 位纯数字；一经发放不再变更，员工离职后工号永久保留。
- **每个数字员工有且仅有一位在职真人 guardian**：创建人默认担任，绑定等操作可追责到人。
- **零 OAuth 集成**：与钉钉的交互（登录、通讯录校验、@消息订阅、回发消息）全部经官方 CLI `dws` 完成，无需申请开放平台应用、回调域名或公网地址。
- **凭证彼此隔离**：每个数字员工一份独立登录态目录，平台只管理目录生命周期，不接触令牌本体。
- **声明式运维**：员工以 YAML 声明，服务启动即自动对齐到员工库；声明文件写错时保留既有员工并记录原因，不会把人删掉。
- **群内上下文按人隔离**：同一个群里，不同同事与数字员工的对话各自独立延续，不会互相串台。
- **过载与超时保护**：消息处理有并发上限、排队上限与单轮超时；积压或超时会明确回复提示并留痕，不静默丢弃、不无限期挂起。
- **长会话自动压缩**：对话上下文接近模型窗口上限时自动压缩——较早的内容折叠成一条摘要，最近的消息保留原文，长期对话不会因上下文撑满而停止工作。
- **注入防线**：外部输入一律以参数数组传给命令行工具，绝不拼接 shell 字符串。
- **全链路审计**：每次工具调用、消息收发、状态变更都追加写入审计库。
- **轻量存储**：员工、会话、审计三个 SQLite 库配合进程内队列即可运行；经 Prisma 与应用层抽象可平滑迁移到 PostgreSQL、Redis 与专用密钥服务。

## 工作原理

```
config/employees/*.yaml ──启动自动对齐──▶ 员工库（工号发放 / 状态 / 绑定）
                                          │
钉钉群 @小助 ─▶ dws 事件订阅 ─▶ 消息回路 ─▶ 匹配该员工的 Agent 配置
                                          │                │
                  dws 发送群消息 ◀─────────┴── pi coding agent（会话库记录上下文）
                                          │
                                     审计库（登录 / 绑定 / 消息 / 状态变更全链路留痕）
```

## 能力与验证状态

| 能力 | 代码 | 真实环境验证 |
|---|---|---|
| 员工声明、工号发放、在职/离职与 guardian 校验 | ✅ | ✅ |
| 钉钉设备流登录托管、只读校验绑定 | ✅ | ✅ |
| Agent 对话（人格/模型/工具装配、会话续接） | ✅ | ⬜ 需配置模型 API Key |
| 群内 @ 消息自动回复 | ✅ | ⬜ 需第二个钉钉账号在群内发起 @（同账号自己 @ 自己不会触发，可避免数字员工互相回环） |
| 群内按人隔离上下文、积压与超时保护 | ✅ | ⬜ 随群内真实 @ 一并验证 |
| 处理过程可观测（工具调用记录，思考内容可选展示） | ✅ | ⬜ 随真实模型对话一并验证 |
| 长会话上下文自动压缩 | ✅ | ⬜ 需真实模型下的一段长对话 |
| 全链路审计与命令行观测 | ✅ | ✅ |
| 测试与验证脚本（单测 + 假钉钉 + 回显模式，无需外部依赖） | ✅ | ✅ |

未闭环项的外部条件与复跑方式记录在 [`TODO.md`](TODO.md)。

## 快速开始

### 前置条件

- Node ≥ 22、pnpm 10
- 真实钉钉链路需钉钉官方 CLI `dws` 在 PATH
- 真实模型对话需 `AISTAFF_MODEL_API_KEY`；没有模型凭证时可设 `AISTAFF_AGENT_RUNNER=echo`，用回显模式走完除模型输出外的全部流程

### 启动

```bash
pnpm install
pnpm run db:push          # 生成员工 / 会话 / 审计三个库（文件位于 data/）
pnpm run dev              # 启动服务，HTTP 接口监听 http://127.0.0.1:3000
```

core 启动时会扫描 `config/employees/*.yaml`，自动把员工库对齐到声明内容（建档、发号、状态收敛）。随后在另一个终端查看：

```bash
pnpm run cli employees list
```

### 声明一个数字员工

```yaml
# config/employees/xiaozhu.yaml
name: 小助
type: DIGITAL
dept: 公共服务部
guardian: human01            # 负责该数字员工的真人（取其 YAML 文件名）
bindings:
  - provider: DINGTALK
agentProfile:
  model: anthropic/claude-sonnet-4-5
  systemPrompt: 你是组织内的数字员工「小助」，回答简洁、以同事口吻协作。
  tools: []                  # 显式空数组 = 禁用全部工具
```

### 上线对话闭环

以下 `aistaff …` 均指 `pnpm run cli …`（如 `pnpm run cli login AI000001`）：

```bash
aistaff login AI000001                    # 打开钉钉登录流程，按提示在手机钉钉上确认授权
aistaff bind AI000001 --provider DINGTALK --external-user-id <userId>   # 只读校验钉钉账号（存在 + 姓名一致）后完成绑定
aistaff listen AI000001                   # 群内 @ 消息 → Agent → 自动回复
aistaff chat AI000001 "你好"              # 在命令行直接对话，查看处理过程与回复
```

## 管理 CLI

| 命令 | 作用 |
|---|---|
| `health` | 服务健康检查 |
| `employees list` | 列出员工及状态 |
| `employee start\|stop\|offboard <工号>` | 启用 / 停用 / 离职（离职为终态，工号不回收） |
| `login <工号> [--profile <组织ID>]` | 打开钉钉登录流程，登录态存入该员工独立目录；`--profile` 指定授权组织 |
| `bind <工号> --provider DINGTALK --external-user-id <id>` | 只读校验并绑定钉钉账号（确认账号存在、姓名与声明一致） |
| `connection <工号>` | 查看某员工的登录态与绑定状态 |
| `chat <工号> <消息...> [-c <会话ID>]` | 与员工对话，默认展示工具调用过程；`AISTAFF_SHOW_THINKING=1` 时额外展示模型思考；发生上下文压缩时展示 `[compact]` 及前后 token 数 |
| `conversations <工号>` | 查看历史会话与消息 |
| `listen <工号> [--stop]` | 启动 / 停止群内 @ 消息自动回复（停止时向子进程发送 SIGTERM 优雅停机） |
| `loops` | 查看运行中的消息回路 |
| `audit -n <条数>` | 查看最近审计记录 |

## 环境变量（core 进程）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AISTAFF_PORT` | `3000` | HTTP 端口 |
| `AISTAFF_DATA_DIR` | `data/` | 员工库、会话库、员工工作目录与登录态目录的根位置（审计库固定在项目 `data/` 下） |
| `AISTAFF_CONFIG_DIR` | `config/employees` | 员工 YAML 声明目录 |
| `AISTAFF_AGENT_RUNNER` | `pi` | 设为 `echo` 时使用回显模式，不调用模型 |
| `AISTAFF_MODEL_API_KEY` / `AISTAFF_MODEL_PROVIDER` | 无 / `anthropic` | 模型凭证；未设置时使用 pi coding agent 自身的登录配置 |
| `AISTAFF_SHOW_THINKING` | 关 | `1` 时在对话中展示模型思考内容（默认不产生） |
| `AISTAFF_AGENT_COMPACTION` | 开 | 设为 `0` 时关闭长会话的上下文压缩（关闭后上下文会无限增长） |
| `AISTAFF_AGENT_COMPACTION_RESERVE_TOKENS` | `16384` | 距模型窗口上限还剩多少 token 时开始压缩；非法值回落到默认 |
| `AISTAFF_AGENT_COMPACTION_KEEP_TOKENS` | `20000` | 压缩时保留原文的最近 token 数，更早的内容折叠为摘要 |
| `AISTAFF_DWS_BIN` | `dws` | 钉钉命令行工具的可执行文件路径，可指向模拟实现 |
| `AISTAFF_LOOP_MAX_CONCURRENT` | `3` | 同时处理的消息轮数上限，超出的消息排队等待 |
| `AISTAFF_LOOP_MAX_QUEUED` | `50` | 单个员工排队消息上限，超出后新消息跳过并回复提示 |
| `AISTAFF_LOOP_TURN_TIMEOUT_MS` | `180000` | 单轮处理超时，超时后中止并回复提示 |
| `AISTAFF_CORE_URL` | `http://127.0.0.1:3000` | 管理命令行连接的服务地址（命令行进程读取） |

## 测试与验证

```bash
pnpm --filter @aistaff/core test        # 单元测试
bash scripts/verify-m1.sh               # 员工声明对齐与工号发放
bash scripts/verify-m2.sh               # 在职/离职与 guardian 校验
bash scripts/verify-m3.sh               # 登录托管与绑定校验
bash scripts/verify-m4.sh               # 对话链路
bash scripts/verify-m5.sh               # 消息闭环与停机
```

以上脚本无需钉钉账号和模型凭证：用 `AISTAFF_DWS_BIN` 指向的模拟 `dws`、`AISTAFF_AGENT_RUNNER=echo` 回显模式运行，每个脚本使用独立的临时数据目录，互不污染。已验证的 `dws` 版本为 v1.0.54–v1.0.62。

`scripts/verify-m3-live.sh` / `verify-m5-live.sh` 面向真实钉钉环境：设备流登录、只读校验绑定，以及群内 @ → 自动回复。后者需要两个钉钉账号配合（一个在群内发起 @，一个是数字员工本身）。

## 仓库结构

```
apps/core/   常驻服务：员工目录、账号绑定、Agent 运行时、消息闭环、审计
apps/cli/    aistaff 管理命令行，经 core 的 HTTP 接口操作
config/      员工 YAML 声明
scripts/     测试与验证脚本
docs/        设计文档
```
