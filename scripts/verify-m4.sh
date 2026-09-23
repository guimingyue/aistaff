#!/usr/bin/env bash
# M4 出口验证：echo 桩全链路（CLI chat -> 装配 -> sessions.db 持久化 -> 审计）+ pi 真实通道探测
# 真实模型对话需模型凭证（AISTAFF_MODEL_API_KEY 或 pi auth.json），按用户决定留待凭证提供后验证。
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
start_core() { # $1: extra env prefix description
  for pid in $(lsof -ti tcp:3000 || true); do kill "$pid" 2>/dev/null || true; done
  sleep 1
  (cd apps/core && env $RUNNER_ENV pnpm start > /tmp/aistaff-m4-core.log 2>&1) &
  CORE_PID=$!
  for i in $(seq 1 30); do
    curl -sf "$API/health" > /dev/null 2>&1 && return 0
    sleep 1
  done
  fail "core 未启动，见 /tmp/aistaff-m4-core.log"
}

step "0/6 库同步 + echo 桩模式启动 core"
RUNNER_ENV="" pnpm --filter @aistaff/core run db:push > /tmp/m4-push.log 2>&1 || { cat /tmp/m4-push.log; fail "db push 失败"; }
RUNNER_ENV="AISTAFF_AGENT_RUNNER=echo"
start_core

step "1/6 CLI chat：新会话两轮对话"
out1=$(cli chat AI000001 "M4 第一轮：请自我介绍")
echo "$out1"
echo "$out1" | grep -q '\[echo:AI000001\]' || fail "echo 桩未生效"
CONV_ID=$(printf '%s' "$out1" | sed -n 's/^\[\([^] ]*\).*/\1/p')
[ -n "$CONV_ID" ] || fail "未取得 conversationId：$out1"
out2=$(cli chat AI000001 --conversation "$CONV_ID" "M4 第二轮")
echo "$out2"
echo "$out2" | grep -q "\[$CONV_ID" || fail "第二轮未续用同一会话"

step "2/6 sessions.db：会话与四条消息持久化 + pi 会话档案回写"
row=$(sqlite3 data/sessions.db "SELECT (SELECT COUNT(*) FROM Message m JOIN Conversation c ON m.conversationId=c.id WHERE c.id='$CONV_ID'), (SELECT agentSessionFile FROM Conversation WHERE id='$CONV_ID') != '' ;")
echo "$row"
[ "$row" = "4|1" ] || fail "sessions 持久化不完整（期望 4 条消息+档案路径，实际 $row）"
[ -d data/workspaces/AI000001 ] || fail "缺少员工 workspace 目录 data/workspaces/AI000001"

step "3/6 审计：agent.run >= 2 且含模型与耗时"
cli audit -n 10 | grep -E 'agent\.run .*AI000001/' || fail "缺少 agent.run 审计"
cnt=$(sqlite3 data/audit.db "SELECT COUNT(*) FROM AuditEvent WHERE action='agent.run' AND target LIKE 'AI000001/%';")
[ "$cnt" -ge 2 ] || fail "agent.run 审计条数 $cnt < 2"
sqlite3 data/audit.db "SELECT detail FROM AuditEvent WHERE action='agent.run' ORDER BY id DESC LIMIT 1;" | grep -q durationMs || fail "审计缺耗时"

step "4/6 拒绝路径：真人无 AgentProfile -> 400 + reject 审计"
if cli chat 000001 "自言自语" 2>/tmp/m4-neg.err; then
  fail "真人对话竟然成功"
fi
grep -q "未配置 AgentProfile" /tmp/m4-neg.err || { cat /tmp/m4-neg.err; fail "拒绝原因异常"; }
cnt=$(sqlite3 data/audit.db "SELECT COUNT(*) FROM AuditEvent WHERE action='agent.run.reject' AND target LIKE '000001/%';")
[ "$cnt" -ge 1 ] || fail "缺少 reject 审计"

step "5/6 单元测试"
if ! pnpm --filter @aistaff/core test > /tmp/m4-test.log 2>&1; then
  tail -30 /tmp/m4-test.log
  fail "测试失败"
fi
tail -8 /tmp/m4-test.log

step "6/6 pi 真实通道探测（默认 PiAgentRunner，无凭证时应明确报错并留审计）"
RUNNER_ENV=""
start_core
code=$(curl -s --max-time 120 -o /tmp/m4-pi.json -w '%{http_code}' -X POST "$API/employees/AI000001/chat" \
  -H 'content-type: application/json' -d '{"message":"pi 通道探测"}' || echo TIMEOUT)
echo "HTTP $code: $(head -c 400 /tmp/m4-pi.json 2>/dev/null || true)"
if [ "$code" = "TIMEOUT" ]; then
  echo "PROBE_TIMEOUT：pi 运行时无凭证下长时间挂起——凭证就绪后复测，本次不判定失败"
elif [ "$code" = "200" ]; then
  echo "PROBE_OK：pi 通道直接对话成功"
else
  grep -qiE 'key|auth|credential|model|api|offline|network|resolve' /tmp/m4-pi.json \
    || { cat /tmp/m4-pi.json; fail "pi 探测返回了无法归类的错误"; }
  echo "PROBE_BLOCKED：装配链路可达，阻塞点=模型凭证（用户已决定暂缓：先不用验证）"
fi
cnt=$(sqlite3 data/audit.db "SELECT COUNT(*) FROM AuditEvent WHERE action LIKE 'agent.run%' AND target LIKE 'AI000001/%';")
[ "$cnt" -ge 3 ] || fail "pi 探测未见审计（agent.run* 条数 $cnt）"

echo
echo "M4_VERIFY_DONE"
echo "待验证点：真实模型对话（提供 AISTAFF_MODEL_API_KEY 或 pi 登录后重跑本脚本 step 6 即升级为 PROBE_OK）"
