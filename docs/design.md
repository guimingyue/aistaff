# aistaff 数字员工平台 · 设计文档

版本：v1.0（一期 MVP 定稿）
日期：2026-09-20
状态：已评审确认，M1 未开工

---

## 1. 背景与目标

aistaff 是一个"数字员工"平台：在平台中创建数字员工，使其在组织内获得**独立工号**和**员工账号**，与真人员工同构地进入通讯录与汇报线，可被同事像对待真人同事一样使用（群里 @、对话、交付任务）。

数字员工的账号用途（按演进顺序）：

1. **对外沟通身份**（一期）：以钉钉/飞书账号在 IM 中收发消息。
2. **登录内部系统**（二期+）：绑定账号后由各内部系统按自身权限体系放行。
3. **平台内统一认证**（二期+）：依赖平台原生账号系统，一期不做。

数字员工的 AI 能力（"大脑"）在平台内运行，基于一期选型 **pi coding agent**（TypeScript，github.com/earendil-works/pi）。

## 2. 设计原则

1. **做认证（authn）不做授权（authz）**：平台只管"你是谁"。"你能干什么" follow 所接入的三方账号体系的权限系统；平台不建 RBAC、不复制/双写三方权限数据。
2. **真人 / 数字员工同构**：同一 Employee 模型、同一通讯录与汇报线；数字员工差异（guardian、AgentProfile、workspace）放扩展实体，不另立体系。
3. **身份与凭证正交**：工号是权威身份，一经发放永不变更、永不复用；外部账号绑定是可增删的凭证层。
4. **声明式、可无 UI 运行**：一期一切操作通过 YAML 配置 + 管理 CLI 完成，Web 控制台是核心服务之上 later 的一层皮，不产生返工。
5. **轻量优先，升级留路**：SQLite / 进程内队列起步，经 ORM 与应用层抽象保证向 PostgreSQL / Redis / Vault 平滑升级。

## 3. 领域模型

```
Employee（真人 / 数字员工同构）
├── employeeNo        工号，权威主键
│                     数字员工：AI + 6 位零填充序号（AI000001）
│                     真人：6 位纯数字（000123）
│                     双独立序列；全局唯一 / 永不变更 / 离职永久保留不复用
├── type              HUMAN | DIGITAL
├── name / dept / reportsTo        （一期最简组织模型：字段级，非组织树）
├── status            ACTIVE | SUSPENDED | OFFBOARDED（状态机）
├── guardianEmployeeNo             （仅 DIGITAL：有且仅有 1 个在职真人；
│                                   创建人默认；转移需双方确认）
│
├── ExternalBinding 0..N
│   ├── provider        DINGTALK | FEISHU（模型层扩展点，未来可加 NATIVE）
│   ├── externalUserId  三方账号 ID（预填绑定，见 §5.2）
│   ├── bindingStatus   PENDING → BOUND → UNBOUND
│   └── cliProfileDir   该员工在三方 CLI 的隔离登录态目录
│
└── AgentProfile 1..1   （仅 DIGITAL）
    ├── systemPrompt    角色人格（以 AGENTS.md 约定注入）
    ├── model / params  模型与参数（API Key 为平台级统一配置，员工不持有）
    ├── tools / skills  工具与技能装配清单
    └── status          ENABLED | DISABLED
```

一期**不建表**、仅在设计中保留的实体：`AuthAccount`（平台认证账号）、组织树、权限模型。

### 实体关系要点

- 凭证的权限边界天然在三方：员工能收发的消息范围、可见的群，由钉钉/飞书侧对该账号的配置决定。
- 平台侧唯一的行为约束（不设权限模型前提下的兜底）：每次 CLI 调用、消息收发、状态变更**必记审计**，且绑定操作可追责到 guardian。

## 4. 集成方式：官方 CLI，零 OAuth

一期与钉钉/飞书的所有交互都通过各自的**官方 CLI** 完成（登录、通讯录只读校验、@消息订阅接收、消息回复发送）：

- **不做开放平台应用授权**：无 appKey/appSecret、无事件回调域名、无公网可达要求；密钥保管（保险库）随凭证消失，一期不存在平台侧秘密。
- **CLI 登录托管**：`aistaff login` 驱动 CLI 完成登录，登录态存于**每员工独立的 CLI profile 目录**（独立 `HOME`/`XDG_*` 环境变量实现隔离），平台只管理目录生命周期，不触碰 token 本体。
- **进程调用纪律**：exec CLI 一律 argv 数组传参，消息内容等外部输入**绝不拼接 shell 字符串**（注入防线）。
- 适配器抽象 `DirectoryAdapter`：`login / verifyUser / subscribe / send / status`，钉钉、飞书各一实现；未来接入新身份源 = 新增实现。
- 已确认能力：CLI 支持接收/订阅 @消息（接收链路成立）。

## 5. 关键流程

### 5.1 数字员工入职（一期全程配置驱动）

1. 管理员编写 `config/employees/ai000001.yaml`（姓名/部门/汇报线/guardian/AgentProfile）
2. `aistaff employee add` → 发号、落库（status=ACTIVE，binding=PENDING）

一期无审批流；审批为后续版本事项。

### 5.2 预填绑定

1. 管理员在钉钉（先）/飞书后台手工创建成员账号，挂部门、进汇报线
2. `aistaff bind AI000001 --provider DINGTALK --external-user-id xxx`
3. 平台经 CLI 只读校验：账号存在 + 姓名匹配 → `BOUND`；不匹配则拒绝并留审计

### 5.3 消息闭环（一期核心场景）

1. CLI 订阅通道收到 @数字员工 消息（实时性不足时轮询兜底）
2. 按 externalUserId 路由 → Employee → AgentProfile
3. agent-runtime 以该员工的 pi-coding-agent 实例 + workspace 运行，流式产出
4. 经同一通道回发；非文本消息（图片/富卡片）一期降级为"暂不支持"提示
5. 全链路记审计（触发人、消息、运行摘要、耗时）

### 5.4 停用 / 离职

status → SUSPENDED/OFFBOARDED；工号永久保留；binding 标记 + 通知 guardian 前往三方手工处理，一期不回写三方通讯录；对应 CLI profile 与 workspace 归档。

## 6. 技术栈与仓库形态

- **语言/框架**：全栈 TypeScript。核心服务 NestJS 模块化单体；pi SDK 同语言，无跨栈成本。
- **AI 运行时**：**pi-coding-agent 库化、服务端进程内运行**（非 CLI 子进程）。选它而非裸 `pi-agent-core` 的理由：办公 Agent 所需的文件读写/编辑/bash 工具、会话持久化、extensions/skills 机制开箱即备；仅当未来需深度定制 agent 循环时再下沉 agent-core。锁精确版本，适配代码收敛在 agent-runtime 模块。
- **存储**：Prisma + **SQLite**（一期不上 PG/Redis）。纪律：不写 PG 特有 SQL；enum/JSON 用 TEXT + 应用层校验，升级 PG 时替换原生类型；datasource 换 provider 即迁移。
- **并发约束**：SQLite 单写者锁 → **业务库 / 会话库 / 审计库分文件**。
- **部署**：一期不纳入范围，仅本地运行。既有架构纪律（不用云厂商专有服务、SQLite 文件化、进程内队列）保证后续任意部署形态无需改动业务；部署方案二期单独设计。

```
aistaff/
├── apps/
│   ├── core/          NestJS 服务
│   │   ├── staff-identity/    发号、状态机、guardian、组织字段
│   │   ├── connections/       DirectoryAdapter（钉钉/飞书 CLI 实现）、绑定、profile 目录管理
│   │   ├── agent-runtime/     pi-coding-agent 封装、AgentProfile、会话、workspace
│   │   └── message-loop/      订阅接收 → 路由 → 运行 → 回发
│   └── cli/           aistaff 命令行：login / employee add / bind / start / stop / status
├── config/
│   └── employees/*.yaml       声明式期望状态（启动时 reconcile 进 SQLite）
├── data/                      （运行期生成，git 忽略）
│   ├── staff.db  sessions.db  audit.db
│   ├── workspaces/<employeeNo>/
│   └── cli-profiles/<employeeNo>-<provider>/
└── docs/design.md
```

## 7. 一期范围

### 7.1 范围内

| # | 能力 | 见 |
|---|---|---|
| 1 | 员工身份：双序列发号、状态机、guardian、部门/汇报线字段 | §3 §5.1 |
| 2 | 账号绑定：仅 DINGTALK/FEISHU，预填 + CLI 只读校验 | §5.2 |
| 3 | 通道：CLI 登录托管、@消息订阅、消息回发、profile 隔离 | §4 |
| 4 | AI 运行时：pi-coding-agent 员工实例、AGENTS.md 人格、AgentProfile、会话持久化、平台统一模型 Key | §3 §6 |
| 5 | 操作面：YAML reconcile + `aistaff` 管理 CLI | §5.1 |
| 6 | 审计：状态变更/绑定/消息/CLI 调用，追加写独立库 | §2 §5.3 |

### 7.2 范围外（延后项，接口留扩展点）

平台原生账号系统与 OIDC 统一认证 · Web 控制台 · 创建审批流 · API 自动开号 · 平台侧权限模型 · 富媒体消息（图片/卡片，降级提示）· 飞书通道（一期尾部或二期初，**先钉钉全链路跑通**）· PostgreSQL / Redis · Vault/KMS 后端 · 多 Agent 协作 / 工具市场 / 记忆系统 · **部署与交付形态（容器化、私有化/云托管，二期）**

## 8. 里程碑与出口条件

| 里程碑 | 内容 | 出口条件 |
|---|---|---|
| M1 | monorepo 骨架、Prisma+SQLite 三库、配置 reconcile、审计中间件 | 本地 `pnpm dev` 起全栈；YAML 变更可观测地落库 |
| M2 | staff-identity：发号、状态机、guardian | 工号规则与不变式（唯一/不变/不复用）测试通过 |
| M3 | connections：CLI 登录托管 + 绑定校验（真实钉钉租户） | 预填账号回填后经 CLI 只读校验绑定成功 |
| M4 | agent-runtime：员工实例 + 会话 | 管理 CLI 触发员工对话，流式返回，审计完整 |
| M5 | message-loop 闭环 | **钉钉群 @数字员工 → 自动回复**，Golden Path 全通 |

依赖关系：M3、M4 可并行；M5 依赖两者。通道策略先钉钉、后飞书（复用同一适配器）。

**Golden Path（一期唯一总验收标准）**：配置建员工发工号 → 钉钉预填绑定 + CLI 登录 → 配 AgentProfile → 同事群内 @数字员工 → pi Agent 运行并回复 → 审计可查。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| pi-coding-agent 库化 API 演进不稳定 | 锁精确版本；适配层收敛于 agent-runtime 单模块，升级只改一处 |
| CLI @消息订阅实时性/限流不达标 | M3 真实租户实测；不达标则轮询 + 降频兜底 |
| 无权限模型 → 数字员工行为无法平台侧拦截 | 兜底三件套：guardian 强制追责 + 全量审计 + 绑定即收敛（未 BOUND 不运行）；二期评估速率/白名单 |
| exec CLI 注入 | argv 数组传参纪律 + 单测覆盖外部输入路径 |
| 绑错人 | CLI 只读校验姓名匹配 + 审计留痕 guardian |
| 运行环境未装三方 CLI 或版本不符 | README 列明 CLI 前置依赖与版本要求（M3 交付） |

## 10. 决策记录（摘要）

- 技术栈曾倾向 Python（AI 生态），因确定采用 pi SDK（TypeScript）改判全栈 TS。
- 数据库从 PostgreSQL 降级为 SQLite：一期轻量优先，经 ORM 隔离保留升级路径。
- 账号开通从"API 自动开号"简化为"预填 + 回填绑定"：绕开三方非真人开号政策不确定性。
- 授权模型整体移除：follow 三方权限系统，平台不双写权限。
- 集成方式从开放平台 OAuth 改为官方 CLI：零应用授权、零回调域名、零密钥保管。
- Web 控制台移出一期：YAML + 管理 CLI 驱动，控制台二期盖于同一核心服务。
- 运行时选型 pi-coding-agent（通用办公 Agent 形态）而非裸 pi-agent-core。
- 部署移出一期范围（2026-09-20 定稿修订）：一期仅本地运行，容器化/私有化/云托管随二期再设计。
