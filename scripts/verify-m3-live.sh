#!/usr/bin/env bash
# M3 真实租户验证：真人员工 000001（张三）经平台托管登录 + CLI 只读校验绑定本人钉钉账号。
# 需用户配合：脚本会打印钉钉设备授权链接，请用手机钉钉确认（profile 隔离目录，不影响本机默认 ~/.dws）。
set -euo pipefail
cd "$(dirname "$0")/.."

EMP=000001
PROFILE="$PWD/data/cli-profiles/$EMP-DINGTALK"
API=http://127.0.0.1:3000
CORE_PID=""
cleanup() { [ -n "$CORE_PID" ] && kill "$CORE_PID" 2>/dev/null || true; }
trap cleanup EXIT

step() { echo; echo "== $*"; }
fail() { echo "FAIL: $*"; exit 1; }
cli() { (cd apps/cli && pnpm exec tsx src/main.ts "$@"); }
dws_iso() { HOME="$PROFILE" DWS_CONFIG_DIR="$PROFILE/.dws" dws "$@"; }

step "1/5 启动 core"
for pid in $(lsof -ti tcp:3000 || true); do kill "$pid" 2>/dev/null || true; done
sleep 1
(cd apps/core && pnpm start > /tmp/aistaff-core.log 2>&1) &
CORE_PID=$!
for i in $(seq 1 30); do curl -sf "$API/health" > /dev/null 2>&1 && break; sleep 1; done
curl -sf "$API/health" > /dev/null || fail "core 未启动，见 /tmp/aistaff-core.log"

step "2/5 平台托管登录（aistaff login）：等待手机钉钉授权"
(cli login "$EMP" --provider DINGTALK > /tmp/m3-cli-login.log 2>&1) &
LINK=""
for i in $(seq 1 30); do
  LINK=$(grep -Eo 'https://login\.dingtalk\.com/oauth2/device/verify\.htm\?user_code=[A-Z0-9-]+' /tmp/aistaff-core.log | tail -1 || true)
  [ -n "$LINK" ] && break
  sleep 1
done
if [ -z "$LINK" ]; then
  tail -20 /tmp/aistaff-core.log
  fail "未取到设备授权链接（dws login 可能走了 loopback 浏览器流，见上方日志）"
fi
echo
echo "  ┌─ 请用浏览器/手机钉钉打开并确认 ─────────────────────┐"
echo "  │  $LINK"
echo "  └──────────────────────────────────────────────────────┘"
echo "（等待授权完成，最多 600s…）"
for i in $(seq 1 600); do
  dws_iso auth status -f json 2>/dev/null | grep -q '"authenticated": true' && break
  sleep 1
done
dws_iso auth status -f json | grep -q '"authenticated": true' || fail "登录未完成（见 /tmp/aistaff-core.log）"
echo "OK: 员工 $EMP 的隔离 profile 已登录"

step "3/5 只读取得本人 userId"
SELF=$(dws_iso contact user get-self -f json)
echo "$SELF" | head -c 600; echo
USERID=$(echo "$SELF" | jq -r '.. | .orgUserId? // empty' | head -1)
[ -n "$USERID" ] || fail "无法从 get-self 解析 userId"
echo "userId = $USERID"

step "4/5 aistaff bind（平台侧 CLI 只读校验姓名）"
cli bind "$EMP" --provider DINGTALK --external-user-id "$USERID"

step "5/5 复核 connection + 审计"
cli connection "$EMP" --provider DINGTALK
cli audit -n 10 | grep -E 'connection\.(bind|login|status)' || fail "缺少 connection 审计"

echo
echo "M3_LIVE_VERIFY_DONE"
