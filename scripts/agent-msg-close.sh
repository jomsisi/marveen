#!/usr/bin/env bash
# agent-msg-close.sh -- reliable inter-agent message CLOSE (PUT /api/messages/:id) for the Marveen fleet.
#
# WHY THIS EXISTS: scripts/agent-msg.sh made the SEND path safe (content on STDIN only), but the CLOSE
# path stayed uncovered -- everyone was writing `curl -X PUT ... -d '{"result":"..."}'` by hand, with the
# text inside shell quotes. That is the same two failure classes, on a different endpoint:
#   - a `'` inside a single-quoted payload CLOSES the string; the shell eats characters and the JSON can
#     silently lose them (2026-08-04: two quote marks vanished from a result that was explaining the very
#     difference between `<<'X'` and `<<X`);
#   - `$(...)` or a backtick inside a double-quoted payload EXECUTES in the sender's shell.
# And `result` is exactly the field where we summarise fixes, so it routinely contains quotes, command
# substitutions and code identifiers. The server also echoes it into the automatic [Eredmény] message
# (src/web/routes/messages.ts:200), so a mangled result propagates.
#
# Usage:  cat <<'RES' | bash scripts/agent-msg-close.sh <id> [done|failed] -
#         <result text, any characters>
#         RES
#
# The result ALWAYS comes from STDIN; an argument is refused, for the same reason as in agent-msg.sh.
# Output: success -> "OK closed id=<n> status=<s>"; failure -> "FAIL <reason>", exit 1.
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
LOG="$BASE/store/agent-msg-failures.log"

ID="${1:?message id required}"
STATUS="${2:-done}"
MARKER="${3:--}"

case "$STATUS" in
  done|failed) ;;
  *) echo "FAIL: status must be 'done' or 'failed' (got: $STATUS)" >&2; exit 1 ;;
esac

if [ "$MARKER" != "-" ] || [ "$#" -gt 3 ]; then
  echo "FAIL: the result text must come from STDIN, not from an argument." >&2
  echo "      An argument is rewritten by the shell before this script sees it: an apostrophe TRUNCATES" >&2
  echo "      the payload and \$(...) or a backtick EXECUTES. Use a quoted heredoc:" >&2
  echo "" >&2
  echo "      cat <<'RES' | bash scripts/agent-msg-close.sh $ID $STATUS -" >&2
  echo "      <your result text, any characters>" >&2
  echo "      RES" >&2
  exit 1
fi

case "$ID" in ''|*[!0-9]*) echo "FAIL: id must be numeric (got: $ID)" >&2; exit 1 ;; esac
[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE" >&2; exit 1; }

RESULT="$(cat)"

# Cyrillic homoglyphs -- a WARNING, never a refusal. Same gate as scripts/dash-api.sh, lifted here
# 2026-09-02 after michel measured the gap: that script had the check, these two did NOT, and the
# INTER-AGENT path is where most of our technical text travels (command names, card ids, file paths).
# A Cyrillic letter inside an id or a command produces a NO-MATCH later, not an error now, so nothing
# else in the pipeline can catch it. The measured case: a close body reading "mind a h<cyr>rmat", three
# Cyrillic letters, sent and stored with nobody warned. The text is still sent: a cosmetic character
# must never block a message that is otherwise correct.
HOMOGLYPHS="$(printf '%s' "$RESULT" | python3 -c '
import sys,re
s=sys.stdin.read()
w=sorted({m for m in re.findall(r"\S*[\u0400-\u04FF]\S*", s)})
print(" ".join(w[:6]))' 2>/dev/null)"
if [ -n "$HOMOGLYPHS" ]; then
  echo "WARN: cyrillic homoglyph(s) in the text -- sending anyway, but these will NOT be found by a" >&2
  echo "      later grep/search: $HOMOGLYPHS" >&2
fi

TOKEN="$(cat "$TOKEN_FILE")"

# json.dumps builds the body from the environment -- the text never passes through shell quoting.
BODY="$(STATUS="$STATUS" RESULT="$RESULT" python3 -c 'import json,os; print(json.dumps({"status":os.environ["STATUS"],"result":os.environ["RESULT"]}))')"

attempt=0; max=3; CODE=""
while [ "$attempt" -lt "$max" ]; do
  attempt=$((attempt+1))
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://localhost:${PORT}/api/messages/${ID}" \
          -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$BODY" 2>/dev/null || true)"
  [ "$CODE" = "200" ] && { echo "OK closed id=$ID status=$STATUS"; exit 0; }
  sleep 1
done

echo "$(date '+%F %T') close id=$ID FAILED http=$CODE" >> "$LOG"
echo "FAIL: HTTP $CODE after $max attempts (logged to store/agent-msg-failures.log)" >&2
exit 1
