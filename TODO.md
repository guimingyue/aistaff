# 待办（一期 MVP 未闭环项）

M1–M5 代码与自动化验证已全部完成（`verify-m1…m5.sh` 全绿、32/32 单测）。以下环节因**外部条件不具备**尚未完成真实环境实测，均已在 README.md 如实记录，非代码缺口。

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

## 续跑顺序
第二钉钉身份可用 → 群内 @小助 → 闭环 M5-live；模型 Key 到位 → 重跑 M4 探测。
（组织 CLI 开关、成员改名「小助」、login --profile 定向授权均已于 2026-09-25 实测通过。）
