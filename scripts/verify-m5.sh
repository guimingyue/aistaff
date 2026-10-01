#!/usr/bin/env bash
# M5 出口验证（自动化部分）：假 dws（AISTAFF_DWS_BIN）+ echo 桩跑通完整闭环——
# login -> bind BOUND -> listen -> event consume(NDJSON) -> 入站图片取回 -> 路由 Agent -> message send 回发 -> 审计链。
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

step "0/8 释放端口、布置假 dws profile 状态、启动 core（假CLI+echo桩）"
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
# 资源台账桩：om-4 带一张真图片文件头，om-5 只有视频附件（平台读不了，必须降级）
printf '%s' '{"om-4":[{"resourceId":"med-m5","kind":"png"}],"om-5":[{"resourceId":"vid-m5","kind":"mp4"}]}' > "$DWS_DIR/fake-resources.json"
cat > "$DWS_DIR/inbox.ndjson" <<'JSONL'
{"type":"user_im_message_receive_at","event_id":"evt-m5-1","message_id":"om-1","conversation_id":"cid-m5-group","sender":"张三","sender_open_dingtalk_id":"open-zs","content":"小助，明天上午有什么安排？"}
{"type":"user_im_message_receive_at","event_id":"evt-m5-empty","message_id":"om-2","conversation_id":"cid-m5-group","sender":"张三","sender_open_dingtalk_id":"open-zs","content":""}
{"type":"user_im_message_receive_at","event_id":"evt-m5-inject","message_id":"om-3","conversation_id":"cid-m5-group","sender":"攻击者","sender_open_dingtalk_id":"open-e1","content":"x\" && touch /tmp/m5-pwned #"}
{"type":"user_im_message_receive_at","event_id":"evt-m5-img","message_id":"om-4","conversation_id":"cid-m5-group","sender":"张三","sender_open_dingtalk_id":"open-zs","content":"这个报错截图怎么看？mediaId:med-m5"}
{"type":"user_im_message_receive_at","event_id":"evt-m5-video","message_id":"om-5","conversation_id":"cid-m5-group","sender":"张三","sender_open_dingtalk_id":"open-zs","content":""}
JSONL

(cd apps/core && env AISTAFF_AGENT_RUNNER=echo AISTAFF_DWS_BIN="$FAKE_DWS" pnpm start > /tmp/aistaff-m5-core.log 2>&1) &
CORE_PID=$!
for i in $(seq 1 30); do
  curl -sf "$API/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "$API/health" > /dev/null || fail "core 未启动，见 /tmp/aistaff-m5-core.log"

step "1/8 login + bind（假 CLI 状态文件驱动，与真实 profile 语义一致）"
cli login AI000001 | tail -1
[ -f "$DWS_DIR/fake-auth" ] || fail "fake login 未产生 profile 登录态"
cli bind AI000001 --provider DINGTALK --external-user-id ai-xz-001
cli connection AI000001 --provider DINGTALK | grep -q '"bindingStatus": "BOUND"' || fail "绑定未 BOUND"

step "2/8 listen 启动闭环并消费 @消息"
cli listen AI000001
for i in $(seq 1 30); do
  [ -f "$DWS_DIR/sent.ndjson" ] && [ "$(wc -l < "$DWS_DIR/sent.ndjson")" -ge 5 ] && break
  sleep 1
done
[ -f "$DWS_DIR/sent.ndjson" ] || fail "没有产生任何回发"
cat "$DWS_DIR/sent.ndjson"

step "3/8 回发内容断言：Agent 回复 / 无正文降级 / 注入面"
grep -q '\[echo:AI000001\] 小助，明天上午有什么安排？' "$DWS_DIR/sent.ndjson" || fail "第一条未自动回复"
grep -q '没有我能处理的内容' "$DWS_DIR/sent.ndjson" || fail "空正文消息未降级提示"
grep -q '视频、语音和文件' "$DWS_DIR/sent.ndjson" || fail "只有视频附件的消息未降级为媒体提示"
grep -q 'm5-pwned' "$DWS_DIR/sent.ndjson" || fail "注入样本未原样回显"
[ ! -f /tmp/m5-pwned ] || fail "出现 shell 注入副作用文件"
grep -c '"to":"cid-m5-group"' "$DWS_DIR/sent.ndjson" | grep -q '^5$' || fail "回发目标会话不正确"

step "4/8 入站图片通路：CLI 取图落到员工 workspace，正文照旧回答"
IMG="$DATA_DIR/workspaces/AI000001/inbox/med-m5.png"
[ -f "$IMG" ] || fail "图片资源未落到员工 workspace 的 inbox 下"
[ "$(head -c 8 "$IMG" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] || fail "落盘文件不是 PNG 文件头"
grep -q '这个报错截图怎么看？mediaId:med-m5' "$DWS_DIR/sent.ndjson" || fail "带图消息未连同原文回答"
media_audit=$(sqlite3 data/audit.db "SELECT detail FROM AuditEvent WHERE action='message.media';")
echo "$media_audit" | grep -q '"images":1' || fail "message.media 未记录到 1 张图"
echo "$media_audit" | grep -q '"discovered":1,"images":0,"skipped":1' || fail "视频附件未记为跳过"
[ -f "$DATA_DIR/workspaces/AI000001/inbox/vid-m5.mp4" ] || fail "假 CLI 的视频附件本就该落盘，只是不能当图片读"
# 图片本体不进审计：只记张数与 base64 字符数
if echo "$media_audit" | grep -q 'iVBORw0KGgo'; then fail "审计泄漏了图片 base64 本体"; fi

step "5/8 sessions.db：群内按发送人隔离会话 + 消息持久化"
cnt=$(sqlite3 "$DATA_DIR/sessions.db" "SELECT COUNT(*) FROM Conversation WHERE channel='DINGTALK' AND externalId='cid-m5-group';")
[ "$cnt" = "2" ] || fail "期望 2 条 DINGTALK 会话（open-zs / open-e1 各一条），实际 $cnt"
senders=$(sqlite3 "$DATA_DIR/sessions.db" "SELECT externalSenderId FROM Conversation WHERE externalId='cid-m5-group' ORDER BY externalSenderId;" | paste -sd, -)
[ "$senders" = "open-e1,open-zs" ] || fail "会话发送人隔离不正确：$senders"
msgs=$(sqlite3 "$DATA_DIR/sessions.db" "SELECT COUNT(*) FROM Message m JOIN Conversation c ON m.conversationId=c.id WHERE c.externalId='cid-m5-group';")
[ "$msgs" = "6" ] || fail "期望 6 条消息（3问3答，两条降级不进会话），实际 $msgs"
tagged=$(sqlite3 "$DATA_DIR/sessions.db" "SELECT COUNT(*) FROM Message WHERE role='user' AND senderExternalUserId IS NOT NULL;")
[ "$tagged" -ge 3 ] || fail "入站消息未记录发送人标识"

step "6/8 审计链完整：loop.start / message.inbound×5 / agent.run×3 / message.outbound×5 / message.media"
sqlite3 data/audit.db "SELECT action, COUNT(*) FROM AuditEvent WHERE action IN ('loop.start','message.inbound','agent.run','message.outbound','message.media') GROUP BY action;"
for pair in "loop.start:1" "message.inbound:5" "agent.run:3" "message.outbound:5" "message.media:3"; do
  act=${pair%%:*}; want=${pair##*:}
  got=$(sqlite3 data/audit.db "SELECT COUNT(*) FROM AuditEvent WHERE action='$act';")
  # 重复运行本脚本时计数会累加，因此断言 >= 本轮最低值
  [ "$got" -ge "$want" ] || fail "审计 $act 条数 $got < $want"
done
# 图片本体不进审计：只记张数与 base64 字符数
sqlite3 data/audit.db "SELECT detail FROM AuditEvent WHERE action='message.media';" | grep -q 'iVBORw0KGgo' && fail "审计泄漏了图片 base64 本体"

step "7/8 loops 状态与优雅停机（SIGTERM，不 kill -9）"
cli loops
cli listen AI000001 --stop
cli loops | grep -q '无运行中的闭环' || fail "停机后仍显示运行"
sqlite3 data/audit.db "SELECT detail FROM AuditEvent WHERE action='loop.stop' ORDER BY id DESC LIMIT 1;" | grep -q processed || fail "loop.stop 缺处理计数"

step "8/8 全量单元测试"
if ! pnpm --filter @aistaff/core test > /tmp/m5-test.log 2>&1; then
  tail -30 /tmp/m5-test.log
  fail "测试失败"
fi
tail -8 /tmp/m5-test.log

echo
echo "M5_AUTO_VERIFY_DONE"
echo "真实租户 Golden Path 请运行: bash scripts/verify-m5-live.sh（需钉钉授权，用户已决定暂缓：先不用验证）"
