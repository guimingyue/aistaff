# 待办（一期 MVP 未闭环项）

M1–M5 代码与自动化验证已全部完成（`verify-m1…m5.sh` 全绿、32/32 单测）。以下环节因**外部条件不具备**尚未完成真实环境实测，均已在 README.md 如实记录，非代码缺口。

## 1. 真实钉钉组织 login + bind（M3-live）
- 阻塞：设备授权流实测两次均授权成功，但 Step 4 被组织策略拦截 `CLI data access is not enabled for this organization`；授权组织以手机钉钉当前默认组织为准。
- 前置：本人任超管的组织，并在开发者后台开启「允许成员通过 CLI 访问个人数据」（https://open-dev.dingtalk.com/fe/old#/developerSettings）。
- 绕行已交付：`aistaff login AI000001 --profile <corpId>` 可定向授权组织。
- 前置：组织内该成员姓名须改为「小助」（bind 走姓名精确匹配）。
- 验证：`bash scripts/verify-m3-live.sh`。

## 2. 真实模型员工对话（M4）
- 阻塞：本机无 `AISTAFF_MODEL_API_KEY`（也无 ANTHROPIC_API_KEY）。
- 验证：设置 Key 后重跑 `bash scripts/verify-m4.sh` step 6（PROBE_BLOCKED → PROBE_OK）。

## 3. 真实群 @数字员工 Golden Path（M5-live）
- 阻塞：依赖 1 完成绑定 + `listen` 订阅建立；`user_im_message_receive_at` 只收他人 @，需第二个钉钉账号（同事/家人）入群 @小助。
- 验证：`bash scripts/verify-m5-live.sh`（无模型 Key 时 echo 桩并明示降级）。

## 续跑顺序
组织开关/改名就绪 → `login --profile <corpId>` → `bind` → `listen` → 第二账号群内 @小助 → （可选）模型 Key 重跑 M4 探测。
