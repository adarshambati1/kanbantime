#!/bin/bash
# End-to-end smoke test: OAuth gating, the sync protocol, field-level merge,
# tombstones, the Siri endpoints, the board's `placement` field, prefs, and
# PWA wiring.
#
#   npm run dev            # in one terminal
#   npm test               # in another
#
# The Google round-trip itself isn't covered — it needs a real browser and a
# real account. Everything up to and after the redirect is.
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a
B=${BASE_URL:-http://localhost:4322}
pass=0; fail=0
chk() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($2)"; pass=$((pass+1)); else echo "  FAIL $1: got '$2' want '$3'"; fail=$((fail+1)); fi; }
has() { if echo "$2" | grep -q "$3"; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1: lacks '$3'"; fail=$((fail+1)); fi; }
A=(-H "authorization: Bearer $SHORTCUTS_TOKEN")
JSON=(-H 'content-type: application/json')

echo "== gating =="
# The whole deployment is the private app; only login and OAuth are open.
chk "GET /  redirects"      "$(curl -s -o /dev/null -w %{http_code} $B/)" 302
chk "  ...to /login"        "$(curl -s -o /dev/null -w %{redirect_url} $B/)" "$B/login?next=%2F"
chk "GET /login  200"       "$(curl -s -o /dev/null -w %{http_code} $B/login)" 200
has "offers google"         "$(curl -s $B/login)" "Continue with Google"
chk "login is noindex"      "$(curl -s $B/login | grep -c noindex)" 1
chk "POST /api/sync  401"   "$(curl -s -o /dev/null -w %{http_code} -X POST $B/api/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}')" 401
chk "GET /api/list   401"   "$(curl -s -o /dev/null -w %{http_code} $B/api/list)" 401
chk "GET /api/prefs  401"   "$(curl -s -o /dev/null -w %{http_code} $B/api/prefs)" 401
chk "POST /api/notes/sync 401" "$(curl -s -o /dev/null -w %{http_code} -X POST $B/api/notes/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}')" 401
chk "GET /api/notes/search 401" "$(curl -s -o /dev/null -w %{http_code} "$B/api/notes/search?q=x")" 401

echo "== oauth handshake =="
OUT=$(curl -s -o /dev/null -D - "$B/api/auth/login?next=/")
has "redirects to google"   "$OUT" "accounts.google.com"
has "requests email scope"  "$OUT" "scope=openid.email"
has "sets state cookie"     "$OUT" "oauth_state"
has "state cookie httponly" "$OUT" "HttpOnly"
chk "callback w/o state"    "$(curl -s -o /dev/null -w %{redirect_url} "$B/api/auth/callback?code=x&state=y")" "$B/login?error=state"
chk "callback on cancel"    "$(curl -s -o /dev/null -w %{redirect_url} "$B/api/auth/callback?error=access_denied")" "$B/login?error=cancelled"
chk "open redirect blocked" "$(curl -s -o /dev/null -D - "$B/api/auth/login?next=https://evil.example" | grep -c 'evil.example')" 0
# Logout must not be reachable by navigation: as a GET it was one-click CSRF.
chk "logout GET rejected"   "$(curl -s -o /dev/null -w %{http_code} $B/api/auth/logout)" 404
chk "logout POST no Origin" "$(curl -s -o /dev/null -w %{http_code} -X POST $B/api/auth/logout)" 403
chk "logout POST evil Org"  "$(curl -s -o /dev/null -w %{http_code} -X POST -H 'Origin: https://evil.example' $B/api/auth/logout)" 403
chk "logout POST same Org"  "$(curl -s -o /dev/null -w %{http_code} -X POST -H "Origin: $B" $B/api/auth/logout)" 303

echo "== sync: push then pull (bearer) =="
T1=$(uuidgen); T2=$(uuidgen)
NOW=$(($(date +%s)*1000))
# `st` builds a `ts` map. `placement` is one field now (column/rank/start
# collapsed — see PLAN.md §1.1), so it gets one timestamp like any other.
st() { echo "{\"title\":$1,\"done\":$2,\"notes\":$3,\"due\":$3,\"deleted\":$4,\"placement\":$1,\"minutes\":$1}"; }
plc() { echo "{\"column\":\"$1\",\"rank\":\"$2\",\"start\":$3}"; }
R=$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$T1\",\"title\":\"buy milk\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc backlog m null),\"minutes\":30,\"ts\":$(st $NOW $NOW $NOW $NOW)},
  {\"id\":\"$T2\",\"title\":\"call mom\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc backlog m null),\"minutes\":30,\"ts\":$(st $NOW $NOW $NOW $NOW)}]}")
chk "both records echoed" "$(echo "$R" | python3 -c "
import json,sys
ids={c['id'] for c in json.load(sys.stdin)['changes']}
print('$T1' in ids and '$T2' in ids)")" True
CUR=$(echo "$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cursor"])')
chk "pull at cursor empty" "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":$CUR,\"changes\":[]}" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["changes"]))')" 0
chk "idempotent re-push"   "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":$CUR,\"changes\":[
  {\"id\":\"$T1\",\"title\":\"buy milk\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc backlog m null),\"minutes\":30,\"ts\":$(st $NOW $NOW $NOW $NOW)}]}" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["changes"]))')" 0

echo "== field-level merge (the whole point) =="
# Device A checks the box at T+2000. Device B renames the title at T+1000.
# Neither write may clobber the other.
LATER=$((NOW+2000)); MID=$((NOW+1000))
curl -s -o /dev/null "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":$CUR,\"changes\":[
  {\"id\":\"$T1\",\"title\":\"buy milk\",\"notes\":\"\",\"done\":1,\"due\":null,\"deleted\":0,\"placement\":$(plc backlog m null),\"minutes\":30,\"ts\":$(st $NOW $LATER $NOW $NOW)}]}"
R2=$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$T1\",\"title\":\"buy oat milk\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc backlog m null),\"minutes\":30,\"ts\":$(st $MID $MID $NOW $NOW)}]}")
chk "title from B, done from A" "$(echo "$R2" | python3 -c "
import json,sys
for c in json.load(sys.stdin)['changes']:
    if c['id']=='$T1': print(c['title'],'|',c['done'])")" "buy oat milk | 1"

echo "== tombstone =="
DEL=$((NOW+3000))
curl -s -o /dev/null "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$T2\",\"title\":\"call mom\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":1,\"placement\":$(plc backlog m null),\"minutes\":30,\"ts\":$(st $NOW $NOW $NOW $DEL)}]}"
chk "delete propagates" "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
print([c['deleted'] for c in json.load(sys.stdin)['changes'] if c['id']=='$T2'][0])")" 1

echo "== siri endpoints =="
chk "quick-add json"     "$(curl -s -X POST $B/api/quick-add "${A[@]}" "${JSON[@]}" -d '{"title":"pick up dry cleaning"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')" True
chk "quick-add raw text" "$(curl -s -X POST $B/api/quick-add "${A[@]}" -d 'water the plants' | python3 -c 'import json,sys;print(json.load(sys.stdin)["title"])')" "water the plants"
chk "bad bearer 401"     "$(curl -s -o /dev/null -w %{http_code} -X POST $B/api/quick-add -H 'authorization: Bearer wrong' -d 'x')" 401
chk "list speaks"        "$(curl -s "$B/api/list?format=text" "${A[@]}" | grep -c 'dry cleaning')" 1
chk "empty title 400"    "$(curl -s -o /dev/null -w %{http_code} -X POST $B/api/quick-add "${A[@]}" -d '   ')" 400
chk "deleted not spoken" "$(curl -s "$B/api/list?format=text" "${A[@]}" | grep -c 'call mom')" 0

echo "== board fields (placement) =="
# The board and timetable state must survive a round trip as one `placement`
# object, not three independent fields.
BT=$(uuidgen)
curl -s -o /dev/null "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$BT\",\"title\":\"ship the board\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc today q null),\"minutes\":45,\"ts\":$(st $NOW $NOW $NOW $NOW)}]}"
chk "placement.column round-trips" "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
print([c['placement']['column'] for c in json.load(sys.stdin)['changes'] if c['id']=='$BT'][0])")" today
chk "placement.rank round-trips"   "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
print([c['placement']['rank'] for c in json.load(sys.stdin)['changes'] if c['id']=='$BT'][0])")" q
chk "minutes round-trips"          "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
print([c['minutes'] for c in json.load(sys.stdin)['changes'] if c['id']=='$BT'][0])")" 45
chk "minutes clamped to max 720"   "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$BT\",\"title\":\"ship the board\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc today q null),\"minutes\":99999,\"ts\":{\"title\":$NOW,\"done\":$NOW,\"notes\":$NOW,\"due\":$NOW,\"deleted\":$NOW,\"placement\":$NOW,\"minutes\":$((NOW+1))}}]}" | python3 -c "
import json,sys
print([c['minutes'] for c in json.load(sys.stdin)['changes'] if c['id']=='$BT'][0])")" 720
chk "bad column remapped, not dropped" "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$BT\",\"title\":\"ship the board\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc nonexistent-column z null),\"minutes\":45,\"ts\":{\"title\":$NOW,\"done\":$NOW,\"notes\":$NOW,\"due\":$NOW,\"deleted\":$NOW,\"placement\":$((NOW+2)),\"minutes\":$NOW}}]}" | python3 -c "
import json,sys
print([c['placement']['column'] for c in json.load(sys.stdin)['changes'] if c['id']=='$BT'][0])")" backlog

# A move is one field write (`placement`), so it must merge without
# disturbing the title.
MOVED=$((NOW+5000))
curl -s -o /dev/null "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$BT\",\"title\":\"ship the board\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc doing q null),\"minutes\":45,\"ts\":{\"title\":$NOW,\"done\":$NOW,\"notes\":$NOW,\"due\":$NOW,\"deleted\":$NOW,\"placement\":$MOVED,\"minutes\":$NOW}}]}"
chk "move merges cleanly"  "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
c=[c for c in json.load(sys.stdin)['changes'] if c['id']=='$BT'][0]
print(c['placement']['column'], c['title'])")" "doing ship the board"

echo "== placement is one field, not three (PLAN.md §1.1 regression) =="
# The exact failure the second architecture review constructed: a kanban
# move and a timetable retime race on the same card. Independently-merged
# column/rank/start could recombine into a state neither device wrote
# (e.g. column from A, start from B). One `placement` field must win or
# lose as a whole.
RT=$(uuidgen)
curl -s -o /dev/null "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$RT\",\"title\":\"race card\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc today q 300),\"minutes\":30,\"ts\":$(st $NOW $NOW $NOW $NOW)}]}"
TA=$((NOW+1000)); TB=$((NOW+2000))
# Device A: drags it to backlog (older write).
curl -s -o /dev/null "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$RT\",\"title\":\"race card\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc backlog z null),\"minutes\":30,\"ts\":{\"title\":$NOW,\"done\":$NOW,\"notes\":$NOW,\"due\":$NOW,\"deleted\":$NOW,\"placement\":$TA,\"minutes\":$NOW}}]}"
# Device B: independently retimes it, unaware of A's move (newer write).
curl -s -o /dev/null "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$RT\",\"title\":\"race card\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc today q 500),\"minutes\":30,\"ts\":{\"title\":$NOW,\"done\":$NOW,\"notes\":$NOW,\"due\":$NOW,\"deleted\":$NOW,\"placement\":$TB,\"minutes\":$NOW}}]}"
# Check all three sub-fields, not just column/start — a buggy implementation
# that still recombined `rank` independently (e.g. landing on A's "z" while
# correctly taking B's column/start) would pass a check that only looked at
# two of the three fields. B's whole placement is {today, q, 500}; A's was
# {backlog, z, null} — nothing here should come from A.
chk "B's placement wins whole, not recombined" "$(curl -s "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
p=[c['placement'] for c in json.load(sys.stdin)['changes'] if c['id']=='$RT'][0]
print(p['column'], p['rank'], p['start'])")" "today q 500"

echo "== prefs (columns) =="
NO_TODAY='{"columns":[{"id":"backlog","label":"Backlog","kind":"kanban"},{"id":"doing","label":"Doing","kind":"kanban"},{"id":"done","label":"Done","kind":"kanban"}]'
chk "GET /api/prefs 200"    "$(curl -s -o /dev/null -w %{http_code} "${A[@]}" $B/api/prefs)" 200
has "default columns"       "$(curl -s "${A[@]}" $B/api/prefs)" '"backlog"'
# 'today' still holds $RT (placed there by the regression test above) — removing
# it must be rejected, with the blocking count included.
BLOCKED=$(curl -s "${A[@]}" "${JSON[@]}" -X POST $B/api/prefs -d "$NO_TODAY,\"ts\":$NOW}")
chk "column removal blocked (409)" "$(curl -s -o /dev/null -w %{http_code} "${A[@]}" "${JSON[@]}" -X POST $B/api/prefs -d "$NO_TODAY,\"ts\":$NOW}")" 409
has "blocking count present" "$BLOCKED" '"count"'
# Same removal succeeds once nothing references the column any more.
CLEARED=$(($(date +%s)*1000))
curl -s -o /dev/null "${A[@]}" -X POST $B/api/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$RT\",\"title\":\"race card\",\"notes\":\"\",\"done\":0,\"due\":null,\"deleted\":0,\"placement\":$(plc doing z null),\"minutes\":30,\"ts\":{\"title\":$CLEARED,\"done\":$CLEARED,\"notes\":$CLEARED,\"due\":$CLEARED,\"deleted\":$CLEARED,\"placement\":$CLEARED,\"minutes\":$CLEARED}}]}"
chk "removal ok once column is empty" "$(curl -s -o /dev/null -w %{http_code} "${A[@]}" "${JSON[@]}" -X POST $B/api/prefs -d "$NO_TODAY,\"ts\":$((CLEARED+1))}")" 200
chk "retired id rejected on reuse" "$(curl -s -o /dev/null -w %{http_code} "${A[@]}" "${JSON[@]}" -X POST $B/api/prefs -d '{"columns":[{"id":"backlog","label":"Backlog","kind":"kanban"},{"id":"doing","label":"Doing","kind":"kanban"},{"id":"done","label":"Done","kind":"kanban"},{"id":"today","label":"Today Again","kind":"timetable"}],"ts":'"$((CLEARED+2))"'}')" 409

echo "== notes: sync, merge, tombstone =="
N1=$(uuidgen); N2=$(uuidgen)
NNOW=$(($(date +%s)*1000))
nts() { echo "{\"title\":$1,\"body\":$1,\"folder\":$1,\"visibility\":$1,\"deleted\":$2}"; }
NR=$(curl -s "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$N1\",\"title\":\"first note\",\"body\":\"hello world\",\"folder\":\"robotics\",\"visibility\":\"private\",\"deleted\":0,\"createdAt\":$NNOW,\"ts\":$(nts $NNOW $NNOW)},
  {\"id\":\"$N2\",\"title\":\"second note\",\"body\":\"unrelated text\",\"folder\":\"general\",\"visibility\":\"private\",\"deleted\":0,\"createdAt\":$NNOW,\"ts\":$(nts $NNOW $NNOW)}]}")
chk "both notes echoed" "$(echo "$NR" | python3 -c "
import json,sys
ids={c['id'] for c in json.load(sys.stdin)['changes']}
print('$N1' in ids and '$N2' in ids)")" True
chk "folder round-trips" "$(echo "$NR" | python3 -c "
import json,sys
print([c['folder'] for c in json.load(sys.stdin)['changes'] if c['id']=='$N1'][0])")" robotics

# Field-level merge: device A edits body at T+2000, device B edits title at
# T+1000 — neither write may clobber the other.
NLATER=$((NNOW+2000)); NMID=$((NNOW+1000))
curl -s -o /dev/null "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$N1\",\"title\":\"first note\",\"body\":\"hello universe\",\"folder\":\"robotics\",\"visibility\":\"private\",\"deleted\":0,\"createdAt\":$NNOW,\"ts\":{\"title\":$NNOW,\"body\":$NLATER,\"folder\":$NNOW,\"visibility\":$NNOW,\"deleted\":$NNOW}}]}"
NR2=$(curl -s "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$N1\",\"title\":\"first note, renamed\",\"body\":\"hello world\",\"folder\":\"robotics\",\"visibility\":\"private\",\"deleted\":0,\"createdAt\":$NNOW,\"ts\":{\"title\":$NMID,\"body\":$NNOW,\"folder\":$NNOW,\"visibility\":$NNOW,\"deleted\":$NNOW}}]}")
chk "title from B, body from A" "$(echo "$NR2" | python3 -c "
import json,sys
for c in json.load(sys.stdin)['changes']:
    if c['id']=='$N1': print(c['title'],'|',c['body'])")" "first note, renamed | hello universe"

NDEL=$((NNOW+3000))
curl -s -o /dev/null "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$N2\",\"title\":\"second note\",\"body\":\"unrelated text\",\"folder\":\"general\",\"visibility\":\"private\",\"deleted\":1,\"createdAt\":$NNOW,\"ts\":{\"title\":$NNOW,\"body\":$NNOW,\"folder\":$NNOW,\"visibility\":$NNOW,\"deleted\":$NDEL}}]}"
chk "delete propagates" "$(curl -s "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
print([c['deleted'] for c in json.load(sys.stdin)['changes'] if c['id']=='$N2'][0])")" 1

echo "== notes: full-text search =="
N3=$(uuidgen)
curl -s -o /dev/null "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$N3\",\"title\":\"practice log\",\"body\":\"xylophone lessons went well today\",\"folder\":\"music\",\"visibility\":\"private\",\"deleted\":0,\"createdAt\":$NNOW,\"ts\":$(nts $NNOW $NNOW)}]}"
chk "grep finds a real match"   "$(curl -s "${A[@]}" "$B/api/notes/search?q=xylophone" | python3 -c "
import json,sys
print(any(n['id']=='$N3' for n in json.load(sys.stdin)['notes']))")" True
chk "grep excludes non-matches" "$(curl -s "${A[@]}" "$B/api/notes/search?q=xylophone" | python3 -c "
import json,sys
print(any(n['id']=='$N1' for n in json.load(sys.stdin)['notes']))")" False
chk "grep respects folder filter" "$(curl -s "${A[@]}" "$B/api/notes/search?q=xylophone&folder=general" | python3 -c "
import json,sys
print(len(json.load(sys.stdin)['notes']))")" 0

echo "== notes: publish lock (NOTES-PLAN.md §1.1) =="
N4=$(uuidgen)
curl -s -o /dev/null "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$N4\",\"title\":\"original title\",\"body\":\"original body\",\"folder\":\"general\",\"visibility\":\"public\",\"deleted\":0,\"createdAt\":$NNOW,\"ts\":$(nts $NNOW $NNOW)}]}"
# Attempt a content edit that keeps it public — the content must not land.
NLOCKED=$((NNOW+1000))
curl -s -o /dev/null "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$N4\",\"title\":\"sneaky edit while still public\",\"body\":\"original body\",\"folder\":\"general\",\"visibility\":\"public\",\"deleted\":0,\"createdAt\":$NNOW,\"ts\":{\"title\":$NLOCKED,\"body\":$NNOW,\"folder\":$NNOW,\"visibility\":$NNOW,\"deleted\":$NNOW}}]}"
chk "content edit blocked while public" "$(curl -s "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
print([c['title'] for c in json.load(sys.stdin)['changes'] if c['id']=='$N4'][0])")" "original title"
# The reverted title's ts must be newer than what the blocked client sent
# ($NLOCKED) — not reverted back to the original ts — or a real client's own
# naive "higher timestamp wins" merge would see its rejected edit as still
# the newest thing anyone wrote and silently re-adopt it locally, reporting
# a save that never actually landed server-side.
chk "reverted ts is newer than the blocked write, not older" "$(curl -s "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
ts=[c['ts']['title'] for c in json.load(sys.stdin)['changes'] if c['id']=='$N4'][0]
print(ts > $NLOCKED)")" True
# Same edit, but also taking it private in the same write — must land.
NUNLOCK=$((NNOW+2000))
curl -s -o /dev/null "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d "{\"cursor\":0,\"changes\":[
  {\"id\":\"$N4\",\"title\":\"edited after unpublishing\",\"body\":\"original body\",\"folder\":\"general\",\"visibility\":\"private\",\"deleted\":0,\"createdAt\":$NNOW,\"ts\":{\"title\":$NUNLOCK,\"body\":$NNOW,\"folder\":$NNOW,\"visibility\":$NUNLOCK,\"deleted\":$NNOW}}]}"
chk "content edit lands once private" "$(curl -s "${A[@]}" -X POST $B/api/notes/sync "${JSON[@]}" -d '{"cursor":0,"changes":[]}' | python3 -c "
import json,sys
print([c['title'] for c in json.load(sys.stdin)['changes'] if c['id']=='$N4'][0])")" "edited after unpublishing"

echo "== agent =="
# Cookie-only, deliberately (PLAN.md §4.1) — this is a chat feature, not a
# Siri one. No live OPENROUTER_API_KEY here, so this only covers the auth
# gate, not a real model round trip.
chk "no auth -> 401"     "$(curl -s -o /dev/null -w %{http_code} -X POST $B/api/agent "${JSON[@]}" -d '{"message":"hi"}')" 401
chk "bearer rejected"    "$(curl -s -o /dev/null -w %{http_code} -X POST $B/api/agent "${A[@]}" "${JSON[@]}" -d '{"message":"hi"}')" 401

echo "== pwa =="
chk "manifest start_url" "$(curl -s $B/manifest.webmanifest | python3 -c 'import json,sys;print(json.load(sys.stdin)["start_url"])')" /
chk "sw.js served"       "$(curl -s -o /dev/null -w %{http_code} $B/sw.js)" 200
chk "icon 192 served"    "$(curl -s -o /dev/null -w %{http_code} $B/icons/icon-192.png)" 200
chk "login links manifest" "$(curl -s $B/login | grep -c 'manifest.webmanifest')" 1

echo
echo "passed: $pass   failed: $fail"
exit $fail
