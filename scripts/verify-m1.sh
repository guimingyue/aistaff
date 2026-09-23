#!/usr/bin/env bash
# M1 出口验证：起 core -> 健康检查 -> CLI 列表 -> 改 YAML -> 观测 reconcile + 审计
set -euo pipefail
cd "$(dirname "$0")/.."

API=http://127.0.0.1:3000
TMP_EMP=config/employees/verify-tmp.yaml
CORE_PID=""
cleanup() {
  [ -n "$CORE_PID" ] && kill "$CORE_PID" 2>/dev/null || true
  # core 的 node 孙进程会先于包装器退出而存活并占住 3000，按端口兜底清理
  for pid in $(lsof -ti tcp:3000 || true); do kill "$pid" 2>/dev/null || true; done
  rm -f "$TMP_EMP"
}
trap cleanup EXIT

step() { echo; echo "== $*"; }

step "1/6 启动 core"
(cd apps/core && pnpm start > /tmp/aistaff-core.log 2>&1) &
CORE_PID=$!
for i in $(seq 1 30); do
  curl -sf "$API/health" > /dev/null 2>&1 && break
  sleep 1
done

step "2/6 健康检查"
curl -sf "$API/health"; echo

step "3/6 初始 reconcile（xiaozhu 声明）"
curl -sf "$API/employees" | head -c 2000; echo

step "4/6 CLI 观测"
pnpm --filter @aistaff/cli exec tsx src/main.ts employees list
pnpm --filter @aistaff/cli exec tsx src/main.ts audit -n 5

step "5/6 新增 YAML 声明 -> 期望 3s 内 reconcile 落库"
cat > "$TMP_EMP" <<'EOF'
name: 验证员
type: DIGITAL
guardian: human01
bindings:
  - provider: FEISHU
EOF
sleep 4
EMP_COUNT=$(curl -sf "$API/employees" | grep -o '"configKey"' | wc -l | tr -d ' ')
echo "员工数: $EMP_COUNT (期望 2)"
curl -sf "$API/employees" | grep -o '"configKey":"[^"]*"' || true

step "6/6 审计事件（期望含 verify-tmp 的 reconcile 记录）"
curl -sf "$API/audit-events?limit=10" | grep -o '"action":"[^"]*","target":"[^"]*"' || true

echo
echo "M1_VERIFY_DONE"
