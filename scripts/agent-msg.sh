#!/usr/bin/env bash
# agent-msg.sh -- reliable inter-agent message send for the Marveen fleet.
#
# WHY: the common `curl -s ... >/dev/null && echo sent` pattern is DANGEROUS -- curl exits 0 even when
# the server REJECTED the request (401/400/5xx), producing a SILENT send failure: the recipient never
# gets the message and two agents can wait on each other forever. The /api/messages router itself is
# fine (HTTP 200 + a message id); the bug is that the SENDER never checks the result. This helper checks
# the HTTP status AND the returned message id, and RETRIES on failure. A message counts as sent only
# when an id came back.
#
# Usage:  cat <<'EOF' | bash scripts/agent-msg.sh <from> <to> -
#         <content, any characters>
#         EOF
#
# THE CONTENT ALWAYS COMES FROM STDIN. Passing it as an argument is REFUSED, because by the time this
# script runs, the shell has already rewritten it and the damage is invisible here:
#   - a double quote inside a double-quoted argument closes the string; the rest splits into further
#     arguments and only $3 survives -> the message is delivered TRUNCATED, with an "OK id=<n>";
#   - `$(...)` or a backtick inside double quotes EXECUTES in the sender's shell and splices its output
#     into the message -- and a failed/empty command leaves no trace at all. Since we routinely send each
#     other shell snippets, this turns quoting a command into RUNNING it.
# The second class cannot be detected here at all: substitution happens BEFORE the call, so "$(id -u)"
# and "0" are indistinguishable to this script. Refusing the argument form is the only check that acts
# before the shell touches the text. A quoted heredoc (<<'EOF') passes every byte through verbatim.
# Output: success -> "OK id=<n>"; failure -> "FAIL <reason>" + a line in store/agent-msg-failures.log, exit 1.
# Env: MARVEEN_WEB_PORT (default 3420).
set -uo pipefail

# base dir = the parent of this script's dir (scripts/..), so it works from any CWD / any install
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
TOKEN_FILE="$BASE/store/.dashboard-token"
URL="http://localhost:${PORT}/api/messages"
LOG="$BASE/store/agent-msg-failures.log"

FROM="${1:?from required}"; TO="${2:?to required}"; C="${3:?content required (or - for STDIN)}"

# STDIN-ONLY GUARD. See the header: the argument form is unsafe in ways this script cannot detect after
# the fact, so refuse it outright. This is the only check that acts BEFORE the shell rewrites the text.
if [ "$C" != "-" ] || [ "$#" -gt 3 ]; then
  echo "FAIL: the content must come from STDIN, not from an argument." >&2
  echo "      An argument is rewritten by the shell before this script sees it: an inner double quote" >&2
  echo "      TRUNCATES the message, and \$(...) or a backtick EXECUTES and splices its output in." >&2
  echo "      Use a quoted heredoc -- it passes every byte through verbatim:" >&2
  echo "" >&2
  echo "      cat <<'EOF' | bash scripts/agent-msg.sh $FROM $TO -" >&2
  echo "      <your message, any characters>" >&2
  echo "      EOF" >&2
  exit 1
fi
C="$(cat)"
[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

BODY="$(FROM="$FROM" TO="$TO" C="$C" python3 -c 'import json,os; print(json.dumps({"from":os.environ["FROM"],"to":os.environ["TO"],"content":os.environ["C"]}))')"

attempt=0; max=3; CODE=""; ID=""
while [ "$attempt" -lt "$max" ]; do
  attempt=$((attempt+1))
  RESP="$(curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
  CODE="$(printf '%s' "$RESP" | tail -n1)"
  JSON="$(printf '%s' "$RESP" | sed '$d')"
  ID="$(printf '%s' "$JSON" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d.get("id","") if isinstance(d,dict) else "")
except Exception:
  print("")' 2>/dev/null)"
  if { [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; } && [ -n "$ID" ]; then
    echo "OK id=$ID"; exit 0
  fi
  sleep 1
done
echo "FAIL from=$FROM to=$TO http=${CODE:-?} id='$ID' (after $max tries)"
printf '%s\tFAIL\tfrom=%s\tto=%s\thttp=%s\tresp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$FROM" "$TO" "${CODE:-?}" "$(printf '%s' "${JSON:-}" | head -c 200)" >> "$LOG" 2>/dev/null || true
exit 1
