#!/usr/bin/env bash
# M3 出口验证（自动化部分）：起 core -> 隔离 profile 观测 -> 未登录 bind 拒绝 + 审计 -> 注入面检查
# 真实租户部分（dws 登录 + 真账号 bind BOUND）由 scripts/verify-m3-live.sh 交互完成。
set -euo pipefail
cd "$(dirname "$0")/.."

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

step "0/5 释放 3000 端口并启动 core"
for pid in $(lsof -ti tcp:3000 || true); do kill "$pid" 2>/dev/null || true; done
sleep 1
(cd apps/core && pnpm start > /tmp/aistaff-core.log 2>&1) &
CORE_PID=$!
for i in $(seq 1 30); do
  curl -sf "$API/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$API/health" > /dev/null || fail "core 未启动，见 /tmp/aistaff-core.log"

step "1/5 connection 观测：小助(AI000001) DINGTALK 绑定 = PENDING + 独立 profile 未登录"
out=$(cli connection AI000001 --provider DINGTALK)
echo "$out"
echo "$out" | grep -q '"bindingStatus": "PENDING"' || fail "绑定应为 PENDING"
echo "$out" | grep -q '"authenticated": false' || fail "新隔离 profile 应未登录"
echo "$out" | grep -q 'cli-profiles/AI000001-DINGTALK' || fail "profile 目录未按员工隔离"

step "2/5 profile 目录真实创建于隔离路径"
[ -d data/cli-profiles/AI000001-DINGTALK/.dws ] || fail "缺少 data/cli-profiles/AI000001-DINGTALK/.dws"

step "3/5 未登录 bind -> 拒绝 + 审计"
if cli bind AI000001 --provider DINGTALK --external-user-id 'x" && echo pwned' 2>/tmp/m3-bind.err; then
  fail "未登录 bind 竟然成功"
fi
if ! grep -q "未登录" /tmp/m3-bind.err; then
  cat /tmp/m3-bind.err
  fail "拒绝原因异常"
fi
[ ! -f ./pwned ] && [ ! -f apps/cli/pwned ] || fail "出现 shell 注入副作用文件"

step "4/5 审计事件包含 connection.*"
cli audit -n 10 | grep -E 'connection\.(bind\.reject|status)' || fail "缺少 connection 审计"

step "5/5 单元测试（假 CLI 全链路：校验/BOUND/降级/注入防线）"
if ! pnpm --filter @aistaff/core test > /tmp/m3-test.log 2>&1; then
  tail -30 /tmp/m3-test.log
  fail "测试失败"
fi
tail -8 /tmp/m3-test.log

echo
echo "M3_AUTO_VERIFY_DONE"
echo "真实租户环节请运行: bash scripts/verify-m3-live.sh（需钉钉 App 扫码授权）"
