#!/usr/bin/env bash
# M2 出口验证：起 core -> 补挂工号 -> 双序列稳定 -> 状态机 CLI -> guardian 保护 -> 审计
set -euo pipefail
cd "$(dirname "$0")/.."

API=http://127.0.0.1:3000
DB=data/staff.db
CORE_PID=""
cleanup() { [ -n "$CORE_PID" ] && kill "$CORE_PID" 2>/dev/null || true; }
trap cleanup EXIT

step() { echo; echo "== $*"; }
fail() { echo "FAIL: $*"; exit 1; }
cli() { (cd apps/cli && pnpm exec tsx src/main.ts "$@"); }

step "0/6 释放 3000 端口"
for pid in $(lsof -ti tcp:3000 || true); do kill "$pid" 2>/dev/null || true; done
sleep 1

step "1/6 schema 同步 + 启动 core（触发 reconcile 补挂工号）"
(cd apps/core && pnpm exec prisma db push --schema prisma/staff.prisma --skip-generate > /dev/null 2>&1) || fail "db push 失败"
(cd apps/core && pnpm start > /tmp/aistaff-core.log 2>&1) &
CORE_PID=$!
for i in $(seq 1 30); do
  curl -sf "$API/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$API/health" > /dev/null || fail "core 未启动，见 /tmp/aistaff-core.log"

step "2/6 期望补挂：human01=000001, xiaozhu=AI000001"
sleep 2
row() { sqlite3 "$DB" "select employeeNo from Employee where configKey='$1';"; }
[ "$(row human01)" = "000001" ] || fail "human01 工号 $(row human01) != 000001"
[ "$(row xiaozhu)" = "AI000001" ] || fail "xiaozhu 工号 $(row xiaozhu) != AI000001"
echo "OK: 000001 / AI000001"

step "3/6 幂等：再次 reconcile 工号不变"
touch config/employees/xiaozhu.yaml
sleep 4
[ "$(row xiaozhu)" = "AI000001" ] || fail "reconcile 变更了工号"
[ "$(sqlite3 "$DB" "select value from Sequence;")" = $'1\n1' ] || fail "序列被重复递增"
echo "OK: 工号与序列稳定"

step "4/6 CLI 停用/启用数字员工"
cli employee stop AI000001
[ "$(sqlite3 "$DB" "select status from Employee where employeeNo='AI000001';")" = "SUSPENDED" ] || fail "停用未生效"
cli employee start AI000001
[ "$(sqlite3 "$DB" "select status from Employee where employeeNo='AI000001';")" = "ACTIVE" ] || fail "启用未生效"
echo "OK: ACTIVE ⇄ SUSPENDED"

step "5/6 guardian 保护：在职数字员工存在时真人离职被拒"
if cli employee offboard 000001 2>/tmp/m2-guardian.err; then
  fail "guardian 离职未被拒绝"
fi
if ! grep -q "guardian" /tmp/m2-guardian.err; then
  cat /tmp/m2-guardian.err
  fail "拒绝原因异常"
fi
[ "$(sqlite3 "$DB" "select status from Employee where employeeNo='000001';")" = "ACTIVE" ] || fail "guardian 状态被误改"
echo "OK: 离职被拒且状态未变"

step "6/6 审计事件"
curl -sf "$API/audit-events?limit=10" | grep -o '"action":"[^"]*","target":"[^"]*"' | head -10
curl -sf "$API/audit-events?limit=10" | grep -q 'employee.status.change' || fail "缺少状态变更审计"
curl -sf "$API/audit-events?limit=10" | grep -q 'employee.status.reject' || fail "缺少离职拒绝审计"

echo
echo "M2_VERIFY_DONE"
