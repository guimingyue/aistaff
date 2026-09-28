# 待办（一期 MVP 未闭环项）

M1–M5 代码与自动化验证已全部完成（`verify-m1…m5.sh` 全绿、47/47 单测）。以下环节因**外部条件不具备**尚未完成真实环境实测，均已在本文档如实记录，非代码缺口。

## ✅ 2026-09-25 真实环境进展（Chating 组织）
- 真实 login + bind **已闭环**：组织开放 CLI 数据访问后，`aistaff login AI000001 --profile <corpId>` 设备授权成功，`bind` 只读校验姓名「小助」→ **BOUND（M3-live 达成）**；`listen` 订阅真实建立（bus state=connected）；CLI 真实出站回发成功（消息落定 openMessageId，`query-send-status` 可查）。
- 实测确认：**同账号自 @ 不触发** `user_im_message_receive_at`（60s 轮询 processed=0），"他人 @"一跳需第二个钉钉身份。
- 配套修复：托管 dws 隔离 profile 启用 `DWS_DISABLE_KEYCHAIN`（macOS 钥匙串 DEK 在隔离 HOME 下超时），token 文件落 gitignore 的 profile 目录。

## 1. 真实群 @数字员工 Golden Path（M5-live）——唯一剩余收发阻塞
- 现状：小助侧 login/bind/listen/出站全真；只差**另一个钉钉账号**在群里 @小助。
- 前置候选：a) 家人/同事手机号受邀加入 Chating（`dws contact user invite`）或拉入任意与小助同群；b) 钉钉「企业专属账号」CLI 能力当前未开放（`ability_not_full_open`），开放后可平台自建数字员工账号（可管理后台先行人工创建）。
- 验证：好友一条 `@小助 你好` → 审计 `message.inbound` + 自动回发即闭环（`bash scripts/verify-m5-live.sh` 同型）。

## 2. 真实模型员工对话（M4）
- 阻塞：本机无 `AISTAFF_MODEL_API_KEY`（也无 ANTHROPIC_API_KEY）。
- 验证：设置 Key 后重跑 `bash scripts/verify-m4.sh` step 6（PROBE_BLOCKED → PROBE_OK）。

## 3. Agent 执行沙箱（方案待设计）
- 现状：数字员工的 Agent 运行在 `data/workspaces/<工号>/` 下，默认具备 bash 与文件写权限，与宿主进程同权限。
- 既定解法：**设计沙箱机制**（隔离执行环境 + 最小权限），让 Agent 可以安全地执行脚本；在此之前不靠收紧工具白名单来"假装安全"。
- 待产出：沙箱边界（容器/子进程/权限清单）、workspace 与宿主文件的可见性规则、审计与超时策略。

## 4. 评审遗留项（已记录，待排期）
2026-09-28 全量设计与代码评审提出 32 项，其中 4 项已修复：argv 参数注入面收口（`--flag=value` + 标识符校验）、YAML 解析失败不再静默删员工、群会话按「会话+发送人」隔离、消息回路并发上限/排队上限/单轮超时。其余待排期：

- 管理 API 无认证且监听全网卡：**有意设计**，后续统一补；review 不再重复提。
- 员工删除 vs 离职：声明撤销走物理删除（`employee.delete`），与"工号永久保留"的口径不一致，应改为 OFFBOARDED + 归档。
- `stopAll` 未接入进程退出钩子：core 被 kill 时 dws 订阅子进程可能泄漏。
- guardian 只在 reconcile 时校验，运行期不复核（guardian 离职后数字员工仍可对话）。
- 设计 §5.4 离职动作（通知 guardian、profile/workspace 归档）未实现。
- 交互式 login 经 HTTP 触发，core 继承 stdio 且无超时。
- `audit.prisma` 数据库路径硬编码 `data/audit.db`，验证脚本会写真实审计库。
- 每轮 reconcile 为每个声明写一条 `config.reconcile.upsert`，审计噪声大。
- 审计无保留期与脱敏策略（消息正文入库）。
- Agent `steps` 内容未审计，只记条数。
- HTTP 异常统一映射 400，缺 404/409/500 区分。
- CWD 相对默认路径在 4 处重复实现，易漂移。
- `PiAgentRunner.modelRuntime` 缓存被拒绝的 Promise 后永久毒化。
- pi `compaction` 关闭，长会话上下文会无限增长。
- `seen` 超 5000 清空，重复投递可能二次处理。
- `channel.stop()` 10s 超时后静默返回，不报告未退出。
- 通道 `start()` 以 `setImmediate` 视作挂载成功，spawn 失败异步才暴露。
- `runCli` 把 ENOENT/超时/非零退出都压成退出码，排障信息丢失。
- 无 lint、无 CI、无 LICENSE。
- 非文本消息判定用"空内容"近似，未读 msgtype。
- 绑定姓名严格全等匹配；`(employeeId, provider)` 唯一允许同一钉钉号挂到多个员工；工号序号无上界校验。

## 续跑顺序
第二钉钉身份可用 → 群内 @小助 → 闭环 M5-live；模型 Key 到位 → 重跑 M4 探测。
（组织 CLI 开关、成员改名「小助」、login --profile 定向授权均已于 2026-09-25 实测通过。）
