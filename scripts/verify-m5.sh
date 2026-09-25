#!/usr/bin/env bash
# M5 出口验证（自动化部分）：假 dws（AISTAFF_DWS_BIN）+ echo 桩跑通完整闭环——
# login -> bind BOUND -> listen -> event consume(NDJSON) -> 路由 Agent -> message send 回发 -> 审计链。
# 真实租户 Golden Path（同事在钉钉群 @数字员工收到回复）由 scripts/verify-m5-live.sh 完成。
set -euo pipefail
cd "$(dirname "$0")/.."

API=http://127.0.0.1:3000
# 隔离数据目录：自动验证不污染开发库与真实登录 profile（audit.db 仍固定追加仓库 data/）
DATA_DIR="$(mktemp -d)/aistaff-data"
mkdir -p "$DATA_DIR"
export AISTAFF_DATA_DIR="$DATA_DIR"
export AISTAFF_STAFF_DATABASE_URL="file:$DATA_DIR/staff.db"
export AISTAFF_SESSIONS_DATABASE_URL="file:$DATA_DIR/sessions.db"
FAKE_DWS="$PWD/apps/core/src/connections/testing/fake-dws.mjs"
PROFILE="$DATA_DIR/cli-profiles/AI000001-DINGTALK"
DWS_DIR="$PROFILE/.dws"
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

step "0/7 释放端口、布置假 dws profile 状态、启动 core（假CLI+echo桩）"
chmod +x "$FAKE_DWS"
for pid in $(lsof -ti tcp:3000 || true); do kill "$pid" 2>/dev/null || true; done
sleep 1
(cd apps/core && pnpm exec prisma db push --schema prisma/staff.prisma --skip-generate > /dev/null 2>&1 \
  && pnpm exec prisma db push --schema prisma/sessions.prisma --skip-generate > /dev/null 2>&1) || fail "临时库 schema 初始化失败"

rm -rf "$DWS_DIR"
mkdir -p "$DWS_DIR"
# 幂等：清掉上一轮验证的 DINGTALK 测试会话
sqlite3 "$DATA_DIR/sessions.db" "DELETE FROM Message WHERE conversationId IN (SELECT id FROM Conversation WHERE externalId='cid-m5-group'); DELETE FROM Conversation WHERE externalId='cid-m5-group';"
printf '{"ai-xz-001": "小助"}' > "$DWS_DIR/fake-users.json"
cat > "$DWS_DIR/inbox.ndjson" <<'JSONL'
{"type":"user_im_message_receive_at","event_id":"evt-m5-1","message_id":"om-1","conversation_id":"cid-m5-group","sender":"张三","sender_open_dingtalk_id":"open-zs","content":"小助，明天上午有什么安排？"}
{"type":"user_im_message_receive_at","event_id":"evt-m5-empty","message_id":"om-2","conversation_id":"cid-m5-group","sender":"张三","sender_open_dingtalk_id":"open-zs","content":""}
{"type":"user_im_message_receive_at","event_id":"evt-m5-inject","message_id":"om-3","conversation_id":"cid-m5-group","sender":"攻击者","sender_open_dingtalk_id":"open-e1","content":"x\" && touch /tmp/m5-pwned #"}
JSONL

(cd apps/core && env AISTAFF_AGENT_RUNNER=echo AISTAFF_DWS_BIN="$FAKE_DWS" pnpm start > /tmp/aistaff-m5-core.log 2>&1) &
CORE_PID=$!
for i in $(seq 1 30); do
  curl -sf "$API/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$API/health" > /dev/null || fail "core 未启动，见 /tmp/aistaff-m5-core.log"

step "1/7 login + bind（假 CLI 状态文件驱动，与真实 profile 语义一致）"
cli login AI000001 | tail -1
[ -f "$DWS_DIR/fake-auth" ] || fail "fake login 未产生 profile 登录态"
cli bind AI000001 --provider DINGTALK --external-user-id ai-xz-001
cli connection AI000001 --provider DINGTALK | grep -q '"bindingStatus": "BOUND"' || fail "绑定未 BOUND"

step "2/7 listen 启动闭环并消费 @消息"
cli listen AI000001
for i in $(seq 1 30); do
  [ -f "$DWS_DIR/sent.ndjson" ] && [ "$(wc -l < "$DWS_DIR/sent.ndjson")" -ge 3 ] && break
  sleep 1
done
[ -f "$DWS_DIR/sent.ndjson" ] || fail "没有产生任何回发"
cat "$DWS_DIR/sent.ndjson"

step "3/7 回发内容断言：Agent 回复 / 非文本降级 / 注入面"
grep -q '\[echo:AI000001\] 小助，明天上午有什么安排？' "$DWS_DIR/sent.ndjson" || fail "第一条未自动回复"
grep -q '暂不支持\|只能处理文本' "$DWS_DIR/sent.ndjson" || fail "非文本消息未降级提示"
grep -q 'm5-pwned' "$DWS_DIR/sent.ndjson" || fail "注入样本未原样回显"
[ ! -f /tmp/m5-pwned ] || fail "出现 shell 注入副作用文件"
grep -c '"to":"cid-m5-group"' "$DWS_DIR/sent.ndjson" | grep -q '^3$' || fail "回发目标会话不正确"

step "4/7 sessions.db：DINGTALK 会话复用与消息持久化"
cnt=$(sqlite3 "$DATA_DIR/sessions.db" "SELECT COUNT(*) FROM Conversation WHERE channel='DINGTALK' AND externalId='cid-m5-group';")
[ "$cnt" = "1" ] || fail "期望 1 条 DINGTALK 会话，实际 $cnt"
msgs=$(sqlite3 "$DATA_DIR/sessions.db" "SELECT COUNT(*) FROM Message m JOIN Conversation c ON m.conversationId=c.id WHERE c.externalId='cid-m5-group';")
[ "$msgs" = "4" ] || fail "期望 4 条消息（2问2答），实际 $msgs"

step "5/7 审计链完整：loop.start / message.inbound×3 / agent.run / message.outbound×3"
sqlite3 data/audit.db "SELECT action, COUNT(*) FROM AuditEvent WHERE action IN ('loop.start','message.inbound','agent.run','message.outbound') GROUP BY action;"
for pair in "loop.start:1" "message.inbound:3" "agent.run:2" "message.outbound:3"; do
  act=${pair%%:*}; want=${pair##*:}
  got=$(sqlite3 data/audit.db "SELECT COUNT(*) FROM AuditEvent WHERE action='$act';")
  # 重复运行本脚本时计数会累加，因此断言 >= 本轮最低值
  [ "$got" -ge "$want" ] || fail "审计 $act 条数 $got < $want"
done

step "6/7 loops 状态与优雅停机（SIGTERM，不 kill -9）"
cli loops
cli listen AI000001 --stop
cli loops | grep -q '无运行中的闭环' || fail "停机后仍显示运行"
sqlite3 data/audit.db "SELECT detail FROM AuditEvent WHERE action='loop.stop' ORDER BY id DESC LIMIT 1;" | grep -q processed || fail "loop.stop 缺处理计数"

step "7/7 全量单元测试"
if ! pnpm --filter @aistaff/core test > /tmp/m5-test.log 2>&1; then
  tail -30 /tmp/m5-test.log
  fail "测试失败"
fi
tail -8 /tmp/m5-test.log

echo
echo "M5_AUTO_VERIFY_DONE"
echo "真实租户 Golden Path 请运行: bash scripts/verify-m5-live.sh（需钉钉授权，用户已决定暂缓：先不用验证）"
