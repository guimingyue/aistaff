#!/usr/bin/env bash
# M5 真实租户 Golden Path：数字员工 AI000001(小助) 经平台托管登录真实钉钉 -> 启动闭环 ->
# 同事在钉钉群 @小助 发一条消息 -> 平台经员工 Agent 自动回发到该群。
# 需用户配合：手机钉钉扫码/确认设备授权；真实模型回复需先 export AISTAFF_MODEL_API_KEY
# （缺省回落 echo 桩，只能验证到“收信->路由->回发”链路，不验证真模型产出）。
set -euo pipefail
cd "$(dirname "$0")/.."

EMP=${EMP:-AI000001}
PROFILE="$PWD/data/cli-profiles/$EMP-DINGTALK"
API=http://127.0.0.1:3000
CORE_PID=""
cleanup() {
  [ -n "$CORE_PID" ] && kill "$CORE_PID" 2>/dev/null || true
  # core 的 node 孙进程会先于包装器退出而存活并占住 3000，按端口兜底清理
  for pid in $(lsof -ti tcp:3000 || true); do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

step() { echo; echo "== $*"; }
fail() { echo "FAIL: $*"; exit 1; }
cli() { (cd apps/cli && pnpm exec tsx src/main.ts "$@"); }
dws_iso() { HOME="$PROFILE" DWS_CONFIG_DIR="$PROFILE/.dws" dws "$@"; }
# 只读查询审计（避免依赖 core 端点分页）
audit_count() { sqlite3 data/audit.db "SELECT COUNT(*) FROM AuditEvent WHERE action='$1' AND target LIKE '$EMP/%';"; }

RUNNER=${AISTAFF_MODEL_API_KEY:+pi}
[ -n "$RUNNER" ] || echo "警告：未设置 AISTAFF_MODEL_API_KEY，本轮以 echo 桩运行（Golden Path 仅验证到回发链路）"

step "1/6 启动 core（真实 dws CLI${RUNNER:+，runner=$RUNNER}）"
for pid in $(lsof -ti tcp:3000 || true); do kill "$pid" 2>/dev/null || true; done
sleep 1
(cd apps/core && env ${AISTAFF_MODEL_API_KEY:+AISTAFF_MODEL_API_KEY="$AISTAFF_MODEL_API_KEY"} ${AISTAFF_MODEL_PROVIDER:+AISTAFF_MODEL_PROVIDER="$AISTAFF_MODEL_PROVIDER"} ${AISTAFF_AGENT_RUNNER:+AISTAFF_AGENT_RUNNER="$AISTAFF_AGENT_RUNNER"} pnpm start > /tmp/aistaff-m5-live-core.log 2>&1) &
CORE_PID=$!
for i in $(seq 1 30); do curl -sf "$API/health" > /dev/null 2>&1 && break; sleep 1; done
curl -sf "$API/health" > /dev/null || fail "core 未启动，见 /tmp/aistaff-m5-live-core.log"

step "2/6 平台托管登录：等待手机钉钉授权（$EMP 的隔离 profile）"
(cli login "$EMP" --provider DINGTALK > /tmp/m5-cli-login.log 2>&1) &
LINK=""
for i in $(seq 1 30); do
  LINK=$(grep -Eo 'https://login\.dingtalk\.com/oauth2/device/verify\.htm\?user_code=[A-Z0-9-]+' /tmp/aistaff-m5-live-core.log | tail -1 || true)
  [ -n "$LINK" ] && break
  sleep 1
done
if [ -n "$LINK" ]; then
  echo
  echo "  ┌─ 请用浏览器/手机钉钉打开并确认 ─────────────────────┐"
  echo "  │  $LINK"
  echo "  └──────────────────────────────────────────────────────┘"
else
  echo "未捕获到设备授权链接，请留意 /tmp/aistaff-m5-live-core.log 与 CLI 输出"
fi
echo "（等待授权完成，最多 600s…）"
for i in $(seq 1 600); do
  dws_iso auth status -f json 2>/dev/null | grep -q '"authenticated": true' && break
  sleep 1
done
dws_iso auth status -f json | grep -q '"authenticated": true' || fail "登录未完成（见 /tmp/aistaff-m5-live-core.log）"
echo "OK: $EMP 隔离 profile 已登录真实钉钉"

step "3/6 只读校验绑定（取该账号本人 userId 后 bind）"
SELF=$(dws_iso contact user get-self -f json)
USERID=$(echo "$SELF" | jq -r '.. | .orgUserId? // empty' | head -1)
[ -n "$USERID" ] || fail "无法从 get-self 解析 userId"
echo "userId = $USERID"
cli bind "$EMP" --provider DINGTALK --external-user-id "$USERID"
cli connection "$EMP" --provider DINGTALK | grep -q '"bindingStatus": "BOUND"' || fail "绑定未 BOUND"

step "4/6 启动消息闭环（dws event consume @消息订阅）"
cli listen "$EMP"
cli loops | grep -q "$EMP" || fail "闭环未运行"

INBOUND0=$(audit_count message.inbound)
echo
echo "  >>> 请现在让一位同事（或本人另一账号）在钉钉群里 @小助 发一条文本消息 <<<"
echo "  （等待入站消息，最多 300s…）"
for i in $(seq 1 300); do
  [ "$(audit_count message.inbound)" -gt "$INBOUND0" ] && break
  sleep 1
done
[ "$(audit_count message.inbound)" -gt "$INBOUND0" ] || fail "未收到 @消息：确认群内已 @ 的是该员工绑定的钉钉账号"

step "5/6 观察自动回复（outbound 审计 + 闭环计数）"
OUT0=$(audit_count message.outbound)
for i in $(seq 1 120); do
  [ "$(audit_count message.outbound)" -gt "$OUT0" ] && break
  sleep 1
done
cli loops
sqlite3 data/audit.db "SELECT action, target, substr(detail,1,160) FROM AuditEvent WHERE action LIKE 'message.%' AND target LIKE '$EMP/%' ORDER BY id DESC LIMIT 4;"
[ "$(audit_count message.outbound)" -gt "$OUT0" ] || fail "已收信但未回发：查 runner/发送错误（/tmp/aistaff-m5-live-core.log）"
echo "OK: 群里 @数字员工 -> 平台自动回复 链路已达成（请在钉钉群目视确认回复内容）"

step "6/6 优雅停机（SIGTERM，绝不用 kill -9）"
cli listen "$EMP" --stop
cli loops | grep -q '无运行中的闭环' || fail "停机后仍显示运行"
sqlite3 data/audit.db "SELECT detail FROM AuditEvent WHERE action='loop.stop' ORDER BY id DESC LIMIT 1;"

echo
echo "M5_LIVE_VERIFY_DONE"
