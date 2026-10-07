#!/usr/bin/env bash
# Is the Tracely server up, and is it the production one? Free, read-only,
# safe to run any time by either developer:
#
#   server/scripts/healthcheck.sh                      # api.jointracely.com
#   server/scripts/healthcheck.sh http://localhost:4477 --mock   # a local mock
#   server/scripts/healthcheck.sh https://api.jointracely.com --commit <sha>
#
# The checks are the ones server/DEPLOY.md runs after every deploy: status
# shape, a bad token answers as free, the extension's CORS allow and deny, the
# prefs route refused, and (when the server reports it) that the live commit
# is the one you expect. Exits non-zero on the first failure, with the reason.
# Needs bash, curl and node — nothing else.
set -u
BASE=${1:-https://api.jointracely.com}; shift || true
MOCK=0; WANT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mock) MOCK=1 ;;
    --commit) shift; WANT=${1:-} ;;
    *) echo "healthcheck: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
EXT="chrome-extension://dffmoeebkkghhgcklkbmaibfhgiegmdm"
fail() { printf 'FAIL  %s\n' "$1"; exit 1; }
ok() { printf 'ok    %s\n' "$1"; }

status=$(curl -sS --max-time 15 "$BASE/api/status") || fail "GET /api/status did not answer"
read -r hasKey mock enforced paid release <<<"$(printf '%s' "$status" | node -e '
  let s=""; process.stdin.on("data", d => s += d).on("end", () => {
    let j; try { j = JSON.parse(s) } catch { console.log("parse parse parse parse parse"); return }
    console.log(String(j.hasKey), String(j.mock), String(j.budget && j.budget.enforced), String("paidBudget" in j), j.release && j.release.commit ? j.release.commit : "-")
  })')"
[ "$hasKey" = "parse" ] && fail "/api/status is not JSON — not a Tracely server"
if [ "$MOCK" = 1 ]; then
  [ "$mock" = "true" ] || fail "/api/status mock=$mock but --mock was asked for"
  ok "/api/status answers (mock mode)"
else
  [ "$hasKey" = "true" ] || fail "/api/status hasKey=$hasKey (no OpenAI key, or not production)"
  [ "$mock" = "true" ] && fail "/api/status mock=true — this is a mock server, not production"
  [ "$enforced" = "true" ] || fail "/api/status budget.enforced=$enforced (spend cap off)"
  [ "$paid" = "true" ] || fail "/api/status has no paidBudget"
  ok "/api/status: hasKey, enforced, paidBudget"
fi

code=$(curl -sS -o /tmp/hc.$$ -w '%{http_code}' --max-time 15 -H "Authorization: Bearer not-a-token" "$BASE/api/entitlement") || fail "GET /api/entitlement did not answer"
plan=$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).plan) } catch { console.log("?") }' /tmp/hc.$$); rm -f /tmp/hc.$$
[ "$code" = "200" ] && [ "$plan" = "free" ] || fail "bad token → $code plan=$plan (want 200 free)"
ok "/api/entitlement: a bad token is served as free"

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X OPTIONS -H "Origin: $EXT" -H "Access-Control-Request-Method: POST" "$BASE/api/check")
[ "$code" = "204" ] || fail "OPTIONS /api/check from our extension → $code (want 204)"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X OPTIONS -H "Origin: chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" -H "Access-Control-Request-Method: POST" "$BASE/api/check")
[ "$code" = "403" ] || fail "OPTIONS /api/check from a foreign extension → $code (want 403)"
ok "/api/check CORS: ours 204, foreign 403"

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X PUT "$BASE/api/prefs")
if [ "$MOCK" = 1 ]; then ok "PUT /api/prefs → $code (local servers may accept it)"; else [ "$code" = "403" ] || fail "PUT /api/prefs → $code (want 403 on a hosted server)"; ok "PUT /api/prefs refused"; fi

if [ -n "$WANT" ]; then
  case "$release" in "$WANT"*|"${WANT:0:7}"*) ok "release.commit $release matches $WANT" ;; "-") fail "server reports no release.commit (older build, or release.json missing) — wanted $WANT" ;; *) fail "release.commit is $release, wanted $WANT" ;; esac
elif [ "$release" != "-" ]; then ok "release.commit $release"; fi
echo "healthy: $BASE"
