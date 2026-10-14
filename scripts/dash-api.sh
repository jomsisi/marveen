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
# Env: MARVEEN_WEB_PORT overrides the port; otherwise WEB_PORT is read from the install's .env
# (default 3420) -- the same file and key the server itself resolves the port from.
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# THE PORT COMES FROM THE SAME .env THE SERVER READS. `MARVEEN_WEB_PORT` used to be the only
# source and NOTHING in the product ever set it: config.ts resolves the port from WEB_PORT in
# the .env file, so the two names never met and `:-3420` was not a fallback but the ONLY branch
# that ever ran. On an install with a non-default WEB_PORT an agent's READS went to the right
# port (they carry dashboardOrigin) while its WRITES came through here, to 3420. Invisible on an
# install that happens to use 3420, because then the two separate values agree by coincidence.
# Resolution order matches watchdog.sh / set-bot-menu.sh / pre-pr-review.sh: an explicit env
# override, then the .env, then the documented default.
PORT="${MARVEEN_WEB_PORT:-$(grep -E '^WEB_PORT=' "$BASE/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')}"
PORT="${PORT:-3420}"
TOKEN_FILE="$BASE/store/.dashboard-token"
LOG="$BASE/store/dash-api-failures.log"

METHOD="${1:?method required (POST|PUT|PATCH|DELETE)}"
API_PATH="${2:?api path required, e.g. /api/daily-log}"

case "$METHOD" in POST|PUT|PATCH|DELETE) ;; *) echo "FAIL: unsupported method: $METHOD" >&2; exit 1 ;; esac
case "$API_PATH" in /api/*) ;; *) echo "FAIL: path must start with /api/ (got: $API_PATH)" >&2; exit 1 ;; esac
[ "$#" -le 2 ] || { echo "FAIL: extra arguments -- the JSON body goes on STDIN, not in an argument." >&2; exit 1; }
[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE" >&2; exit 1; }

# THE READ IS BOUNDED, AND THIS IS NOT BELT-AND-BRACES. `cat` alone blocks FOREVER when STDIN is an
# open descriptor that never delivers and never closes -- a terminal, or an inherited socket. That is
# not a theoretical case: on 2026-09-22 an agent lost 5h46m to exactly this. The call had no `< file`
# redirect at all, so STDIN stayed the tool harness socket; `cat` sat in `anon_pipe_read` from 12:13
# until it was killed by hand at 17:59, and NOTHING anywhere reported a problem.
#
# THE DOCUMENTED RULE DID NOT COVER IT, AND THAT IS THE POINT. Our own notes say a missing body fails
# loudly -- true for `</dev/null`, which closes immediately and reaches the empty-body check below.
# "No redirect at all" never reaches any check, so the LOUD failure and the SILENT hang are one
# keystroke apart, and the silent one is what you get by forgetting rather than by doing.
if [ -t 0 ]; then
  echo "FAIL: STDIN is a terminal -- the JSON body must be piped in (cat <<'JSON' | ... or < file.json)." >&2
  exit 1
fi
BODY="$(timeout "${DASH_API_STDIN_TIMEOUT:-10}" cat)"
if [ $? -eq 124 ]; then
  echo "FAIL: no body on STDIN after ${DASH_API_STDIN_TIMEOUT:-10}s -- STDIN is open but nothing is writing to it." >&2
  echo "      The usual cause is a call with NO stdin redirect at all (the OR-fallback pattern is a" >&2
  echo "      frequent source: the redirect gets attached to only one branch). Add the redirect." >&2
  exit 1
fi
[ -n "$BODY" ] || { echo "FAIL: empty body on STDIN" >&2; exit 1; }

# Validate the JSON HERE, before the server sees it: a malformed body would otherwise become a silent
# 400 with no entry and no log line anywhere.
if ! printf '%s' "$BODY" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  echo "FAIL: the body on STDIN is not valid JSON -- refusing to send (this is exactly the case that" >&2
  echo "      would become a silent 400 with no entry created)." >&2
  exit 1
fi

# Cyrillic homoglyphs in Hungarian prose: a WARNING, never a refusal. Measured 2026-09-02: 34 of them
# sat unnoticed across 23 memory pages and skills, and one was inside a grep pattern -- they cause
# NO-MATCH later, not an error now, so nothing else in the pipeline can catch them. The body is still
# sent: a cosmetic character must never block a write that is otherwise correct.
# A KRITERIUM 2026-10-02 ELOTT `[\u0400-\u04FF]` VOLT, vagyis CSAK CIRILL -- es egy arab
# betu ezen NEMAN atment (marci merte ki a sajat kimeno uzeneten, msg 8549). A jelenseg
# VEGYES IRASRENDSZERU SZO, nem "cirill tartomany": egy eset-lista pontosan az uj esetre vak.
# A tagabb alak 2026-09-02 ota MAR allt a kimeno kapuban, es a homoglif-ellenorzes.py MAR
# azt importalta -- csak ez a harom shell-ut maradt a szuk alakon. Egy implementacio, negy
# fogyaszto: scripts/homoglif-jelzes.py. A stderr SZANDEKOSAN nincs elnyelve: ha a szkript
# hianyzik, az latszodjon, kulonben a vedelem elvesztese ures kimenetnek latszik.
HOMOGLYPHS="$(printf '%s' "$BODY" | python3 "$(dirname "${BASH_SOURCE[0]}")/homoglif-jelzes.py")"
if [ -n "$HOMOGLYPHS" ]; then
  echo "WARN: mixed-script VAGY LATHATATLAN (Cf) karakter(ek) in the body -- sending anyway, but these will NOT be found by a" >&2
  echo "      later grep/search: $HOMOGLYPHS" >&2
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
