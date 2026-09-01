#!/usr/bin/env bash
# dash-api.sh -- write to the local dashboard API without letting the shell touch the payload,
# and FAIL LOUDLY if the server rejected it.
#
# WHY THIS EXISTS (2026-08-04): every memory / daily-log / approval write was hand-built as
# `curl -s -X POST ... -d '{...}'`. That has two failure modes, and only one of them leaves a trace:
#   (a) the shell splices the fragments into VALID JSON -> the entry is created, but characters are
#       silently gone (an apostrophe closes the single-quoted payload; `$(...)` and backticks execute);
#   (b) the splice produces INVALID JSON -> the server answers 400 and NO entry is ever created.
# Case (b) is the dangerous one: the routes do not log 400s, and `curl -s` without a status check says
# nothing, so a lost daily-log entry disappears between the two sides WITHOUT A SINGLE TRACE. You cannot
# audit it afterwards -- the only defence is to not create it and to check the status at write time.
#
# Usage:  cat <<'JSON' | bash scripts/dash-api.sh POST /api/daily-log
#         {"agent_id":"boss","content":"... any characters ..."}
#         JSON
#
# The body ALWAYS comes from STDIN. Output: "OK <method> <path> http=<code>" or "FAIL ..." + exit 1.
# Env: MARVEEN_WEB_PORT (default 3420).
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
TOKEN_FILE="$BASE/store/.dashboard-token"
LOG="$BASE/store/dash-api-failures.log"

METHOD="${1:?method required (POST|PUT|PATCH|DELETE)}"
API_PATH="${2:?api path required, e.g. /api/daily-log}"

case "$METHOD" in POST|PUT|PATCH|DELETE) ;; *) echo "FAIL: unsupported method: $METHOD" >&2; exit 1 ;; esac
case "$API_PATH" in /api/*) ;; *) echo "FAIL: path must start with /api/ (got: $API_PATH)" >&2; exit 1 ;; esac
[ "$#" -le 2 ] || { echo "FAIL: extra arguments -- the JSON body goes on STDIN, not in an argument." >&2; exit 1; }
[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE" >&2; exit 1; }

BODY="$(cat)"
[ -n "$BODY" ] || { echo "FAIL: empty body on STDIN" >&2; exit 1; }

# Validate the JSON HERE, before the server sees it: a malformed body would otherwise become a silent
# 400 with no entry and no log line anywhere.
if ! printf '%s' "$BODY" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  echo "FAIL: the body on STDIN is not valid JSON -- refusing to send (this is exactly the case that" >&2
  echo "      would become a silent 400 with no entry created)." >&2
  exit 1
fi

TOKEN="$(cat "$TOKEN_FILE")"
RESP="$(curl -s -X "$METHOD" "http://localhost:${PORT}${API_PATH}" \
        -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
        -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
CODE="$(printf '%s' "$RESP" | tail -n1)"
JSON="$(printf '%s' "$RESP" | sed '$d')"

case "$CODE" in
  2*) echo "OK $METHOD $API_PATH http=$CODE ${JSON:0:120}"; exit 0 ;;
  *)  echo "$(date '+%F %T') $METHOD $API_PATH FAILED http=$CODE body=${JSON:0:200}" >> "$LOG"
      echo "FAIL: $METHOD $API_PATH -> HTTP $CODE ${JSON:0:200}" >&2
      echo "      (logged to store/dash-api-failures.log -- the write did NOT happen)" >&2
      exit 1 ;;
esac
