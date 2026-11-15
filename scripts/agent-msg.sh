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
# Output: success -> "OK id=<n> queue=<depth> (~<n> min)"; failure -> "FAIL <reason>"
#         + a line in store/agent-msg-failures.log, exit 1.
#   The queue fields come from the POST response: a message is accepted instantly
#   but only DELIVERED into an idle gap in the recipient's pane, which on a busy
#   agent was measured at 80+ minutes. "queue=" is the recipient's pending count
#   including this message; "(~n min)" is the median delivery delay of its recent
#   messages and is OMITTED when there is no history (unknown is not "instant").
#   Both are absent against a server that does not return them, so the line is
#   then exactly "OK id=<n>" as before.
#   At MARVEEN_QUEUE_WARN_AT (default 3) or more waiting, a stderr notice says so
#   at the moment the sender decides whether to send the next one.
#
# LOG FORMAT, store/agent-msg-failures.log (tab-separated, one line per failure):
#   <YYYY-MM-DD HH:MM:SS>  FAIL  from=<a>  to=<b>  url=<endpoint>  http=<code>  resp=<first 200 bytes>
# CHANGED 2026-09: the `url=` field is NEW. It was added together with the
# env-overridable base URL, because from that point a failure can mean "posted to
# the wrong address" and the old line could not distinguish that from a dead
# server. A parser written against the pre-2026-09 format sees one extra field;
# parse by the `key=` names, not by position.
# Env:
#   MARVEEN_API_BASE   full base URL, e.g. https://marveen.example.com (overrides host+port)
#   MARVEEN_WEB_PORT   port for the default localhost base (default: WEB_PORT from the install's .env, else 3420)
#   MARVEEN_TOKEN_FILE bearer token file (default <repo>/store/.dashboard-token)
#   MARVEEN_HOMOGLYPH_BIN  the checker (default <repo>/scripts/lib/homoglyph.py)
#   MARVEEN_HOMOGLYPH_REFUSE  1 = refuse mixed-script text (exit 3); default 0 = warn and send (fork policy)
#   MARVEEN_QUEUE_WARN_AT  queue depth that triggers the stderr notice (default 3, 0 = off)
# MEASURED 2026-09-13: a remote agent runs this helper OUTSIDE this repo, where localhost:3420
# does not exist -- it had to fall back to raw curl, i.e. exactly the unchecked pattern this file was
# written to eliminate. A hardcoded base URL silently un-installs the helper for everyone not on this
# VM, so the base is env-overridable and the two endpoints stay ONE script.
set -uo pipefail

# base dir = the parent of this script's dir (scripts/..), so it works from any CWD / any install
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Dashboard port, the doctor.sh chain: MARVEEN_WEB_PORT, then WEB_PORT from the
# environment, then WEB_PORT from this install's .env, then 3420. An agent's tmux
# session sets neither variable, so on an install with a non-default WEB_PORT the
# env-only lookup sent every message to 3420 (#1869).
PORT="${MARVEEN_WEB_PORT:-${WEB_PORT:-$(sed -n 's/^WEB_PORT=//p' "$BASE/.env" 2>/dev/null | head -1 | tr -d ' "'"'"''; true)}}"
PORT="${PORT:-3420}"
API_BASE="${MARVEEN_API_BASE:-http://localhost:${PORT}}"
API_BASE="${API_BASE%/}"
TOKEN_FILE="${MARVEEN_TOKEN_FILE:-$BASE/store/.dashboard-token}"
URL="${API_BASE}/api/messages"
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

# Cyrillic homoglyphs -- a WARNING, never a refusal. Same gate as scripts/dash-api.sh, lifted here
# 2026-09-02 after michel measured the gap: that script had the check, these two did NOT, and the
# INTER-AGENT path is where most of our technical text travels (command names, card ids, file paths).
# A Cyrillic letter inside an id or a command produces a NO-MATCH later, not an error now, so nothing
# else in the pipeline can catch it. The text is still sent: a cosmetic character must never block a
# message that is otherwise correct.
# A KRITERIUM 2026-10-02 ELOTT `[\u0400-\u04FF]` VOLT, vagyis CSAK CIRILL -- es egy arab
# betu ezen NEMAN atment (marci merte ki a sajat kimeno uzeneten, msg 8549). A jelenseg
# VEGYES IRASRENDSZERU SZO, nem "cirill tartomany": egy eset-lista pontosan az uj esetre vak.
# A tagabb alak 2026-09-02 ota MAR allt a kimeno kapuban, es a homoglif-ellenorzes.py MAR
# azt importalta -- csak ez a harom shell-ut maradt a szuk alakon. Egy implementacio, negy
# fogyaszto: scripts/homoglif-jelzes.py. A stderr SZANDEKOSAN nincs elnyelve: ha a szkript
# hianyzik, az latszodjon, kulonben a vedelem elvesztese ures kimenetnek latszik.
HOMOGLYPHS="$(printf '%s' "$C" | python3 "$(dirname "${BASH_SOURCE[0]}")/homoglif-jelzes.py")"
if [ -n "$HOMOGLYPHS" ]; then
  echo "WARN: mixed-script VAGY LATHATATLAN (Cf) karakter(ek) in the message -- sending anyway, but these will NOT be found by a" >&2
  echo "      later grep/search: $HOMOGLYPHS" >&2
fi

[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

# --- Homoglyph gate, BEFORE the payload is built (MSGGATE924) --------------
# On the RAW text, not on the JSON: json.dumps escapes a Cyrillic letter into
# \uXXXX, and a checker reading the encoded body would be looking at a string
# where the problem is no longer visible as a letter. The gate has to see what
# the sender typed.
#
# WHY IT IS HERE AND NOT IN EACH AGENT'S TOOLBOX. Measured 2026-09-24 across
# three agents: two had built this guard for themselves, independently, because
# both had been bitten by it; the third had no guard at all. And no CLAUDE.md
# prescribes those private wrappers -- they all name THIS helper. The result was
# predictable in hindsight: the agent who WROTE such a wrapper spent a whole day
# calling this script directly, with the check run beside it in a separate
# command instead of in front of it. One message went out contaminated while the
# checker printed "NEM KULDOM EL" next to it. The rule that needs remembering is
# not a rule; it has to sit in the path of the action.
#
# FAIL-OPEN ON A MISSING CHECKER, AND LOUDLY -- a deliberate exception to the
# repo's usual fail-closed stance for gates (see .git/hooks/pre-commit.d). This
# helper is the fleet's mandated message route: blocking every inter-agent
# message on an install whose lib file is absent would be a far worse failure
# than the one being prevented, and it would be a NEW failure, not today's. A
# missing checker is exactly today's state, so the honest behaviour is to send
# and say so. Contaminated text with the checker PRESENT is refused, which is
# where the closed direction belongs.
# Overridable so the suite can measure the missing-checker branch too.
HG="${MARVEEN_HOMOGLYPH_BIN:-$BASE/scripts/lib/homoglyph.py}"
if [ -r "$HG" ] && command -v python3 >/dev/null 2>&1; then
  # THE CHECKER IS A VERDICT, NOT A FILTER: what goes out is the text the
  # sender typed, never the checker's stdout. Measured in the 2026-09-24 review
  # of #1541: a checker that exits 0 with EMPTY stdout made this helper send an
  # empty message and report OK -- a broken tool silently replaced the message
  # instead of failing. The exit code is the only thing read here.
  printf '%s' "$C" | python3 "$HG" >/dev/null
  HG_RC=$?
  case "$HG_RC" in
    0) : ;;
    # 3 is the checker's one documented refusal code; anything else is the
    # CHECKER failing, not the text. They must not share a message: "refused"
    # sends the sender to rewrite a word that may be perfectly fine, while a
    # crashed checker is an unmeasured send and the operator's problem.
    3) if [ "${MARVEEN_HOMOGLYPH_REFUSE:-0}" = "1" ]; then
         echo "FAIL: homoglyph gate refused the message; nothing was sent." >&2
         exit 3
       fi
       # FORK POLICY (v1.40.0 merge): the refusal is OPT-IN here. Our own check above is a
       # WARNING, never a refusal ("a cosmetic character must never block a message that is
       # otherwise correct", decided 2026-09-02), and it already printed the offending
       # characters. Set MARVEEN_HOMOGLYPH_REFUSE=1 for the upstream refusing behaviour.
       echo "WARN: homoglyph checker flagged the text (rc=3) -- sending anyway (MARVEEN_HOMOGLYPH_REFUSE=1 refuses)." >&2 ;;
    *) echo "FAIL: homoglyph checker CRASHED (rc=$HG_RC) at $HG; nothing was sent." >&2
       echo "  This is not a verdict on the text -- fix or unset MARVEEN_HOMOGLYPH_BIN." >&2
       exit 4 ;;
  esac
else
  echo "WARN: homoglyph checker not found at $HG -- sending UNCHECKED." >&2
fi

BODY="$(FROM="$FROM" TO="$TO" C="$C" python3 -c 'import json,os; print(json.dumps({"from":os.environ["FROM"],"to":os.environ["TO"],"content":os.environ["C"]}))')"

attempt=0; max=3; CODE=""; ID=""
while [ "$attempt" -lt "$max" ]; do
  attempt=$((attempt+1))
  RESP="$(curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
  CODE="$(printf '%s' "$RESP" | tail -n1)"
  JSON="$(printf '%s' "$RESP" | sed '$d')"
  # An id ALONE is not delivery. The router answers 200 WITH an id even when the
  # recipient is not running, and says so in a separate `warning` field
  # (src/web/routes/messages.ts) whose text spells out that such a message is
  # LOST rather than queued. This helper read only the id, so it printed
  # "OK id=..." for a message that never arrived -- the exact failure the header
  # above says it exists to prevent, one field further in. The exit code stays 0
  # on purpose: the row really was accepted, so this is not a send failure. It
  # just must not be silent.
  #
  # The queue state rides in the same parse. "-" stands for an empty field so
  # `read` cannot shift the warning text into it. The delay is rounded UP to at
  # least one minute: a 20-second median printed as "~0 min" would read as
  # "instant", the same lie a NULL flattened to 0 would tell.
  read -r ID DEPTH MINS WARN <<EOF
$(printf '%s' "$JSON" | python3 -c 'import sys,json,math
try:
  d=json.load(sys.stdin)
  if not isinstance(d,dict): d={}
except Exception:
  d={}
q=d.get("queue") if isinstance(d.get("queue"),dict) else {}
depth=q.get("queueDepth")
delay=q.get("estimatedDelaySec")
depth="-" if not isinstance(depth,int) or isinstance(depth,bool) else str(depth)
mins="-" if not isinstance(delay,(int,float)) or isinstance(delay,bool) else str(max(1,math.ceil(delay/60)))
w=" ".join(str(d.get("warning","")).split())
print((d.get("id","") or "-"), depth, mins, w)' 2>/dev/null)
EOF
  [ "$ID" = "-" ] && ID=""
  [ "${DEPTH:-}" = "-" ] && DEPTH=""
  [ "${MINS:-}" = "-" ] && MINS=""
  if { [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; } && [ -n "$ID" ]; then
    # "OK id=<n>" stays the prefix: callers and docs grep for it.
    LINE="OK id=$ID"
    [ -n "${DEPTH:-}" ] && LINE="$LINE queue=$DEPTH"
    [ -n "${MINS:-}" ] && LINE="$LINE (~${MINS} min)"
    if [ -n "${WARN:-}" ]; then
      echo "$LINE  WARNING: $WARN" >&2
      echo "$LINE (warning)"
    else
      echo "$LINE"
    fi
    # Printing the number is not enough on its own: the sender has already
    # sent by the time they read it. Say it on stderr, at the moment the next
    # send is being decided. Not a refusal -- an urgent message must still get
    # through.
    WARN_AT="${MARVEEN_QUEUE_WARN_AT:-3}"
    case "$WARN_AT" in ''|*[!0-9]*) WARN_AT=3 ;; esac
    if [ -n "${DEPTH:-}" ] && [ "$WARN_AT" -gt 0 ] && [ "$DEPTH" -ge "$WARN_AT" ]; then
      echo "NOTICE: $DEPTH message(s) are waiting for $TO${MINS:+, measured delay ~${MINS} min}." >&2
      echo "  It is busy; prefer adding to an existing message or a shared card over another message." >&2
    fi
    exit 0
  fi
  sleep 1
done
echo "FAIL from=$FROM to=$TO url=$URL http=${CODE:-?} id='$ID' (after $max tries)"
printf '%s\tFAIL\tfrom=%s\tto=%s\turl=%s\thttp=%s\tresp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$FROM" "$TO" "$URL" "${CODE:-?}" "$(printf '%s' "${JSON:-}" | head -c 200)" >> "$LOG" 2>/dev/null || true
exit 1
