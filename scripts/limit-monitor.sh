#!/bin/bash
# Claude usage-limit monitor (token-free, systemd --user timer).
#
# WHY bash and not a Claude scheduled-task: a Claude agent invocation itself
# consumes the very quota we're guarding. This runs as a plain shell script,
# greps for limit signals, and alerts the owner via the Telegram Bot API.
# Zero Claude tokens.
#
# Signals: rate-limit / usage-limit / 429 / "resets at" in the channels+dashboard
# logs AND in the live tmux panes of the WHOLE fleet (where Claude Code prints
# the limit banner). Dedupes via a state hash so the same event isn't re-alerted.
#
# Two things measured on 2026-08-18 shaped this:
#   - The plan quota is shared by every agent on the subscription, but the
#     banner is printed in whichever pane made the request that hit it. Watching
#     only the main channels pane means a sub-agent can hit the wall silently.
#   - The wordings closest to what the owner actually asks about ("5-hour limit
#     reached", "Approaching Opus weekly limit", "Session limit reached") did
#     NOT match the old pattern. A missed limit is silent; that is the failure
#     that matters here, so the pattern errs wide and the pane match is confined
#     to the bottom region instead.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
STATE="$STORE/.limit-monitor-state"
LOG="$STORE/limit-monitor.log"

log(){ echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# Install-specific values come from .env, never hardcoded: a renamed install
# (BOT_NAME/MAIN_AGENT_ID) has a differently named tmux session, and every
# install has its own owner chat. Resolved the same way as
# channel-keepalive-probe.sh so a rename moves both together.
env_val() { grep -E "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' '; }

MAIN_AGENT_ID="$(env_val MAIN_AGENT_ID)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"

BOT_NAME="$(env_val BOT_NAME)"
BOT_NAME="${BOT_NAME:-$MAIN_AGENT_ID}"

CHAT_ID="$(env_val ALLOWED_CHAT_ID)"
if [ -z "$CHAT_ID" ]; then
  # No owner chat configured: there is nobody to alert, and guessing one would
  # send a quota warning to a stranger. Stay silent rather than misdeliver.
  log "no ALLOWED_CHAT_ID in .env, monitor cannot alert -- exiting"
  exit 0
fi

# ---------------------------------------------------------------------------
# Owner alert, Bot API only. No Claude invocation anywhere in this path -- the
# whole point is that it still works when the quota is gone.
# ---------------------------------------------------------------------------
send_alert() {
  local msg="$1" tag="$2" token
  token="$(grep -oE '[0-9]+:[A-Za-z0-9_-]+' "$HOME/.claude/channels/telegram/.env" 2>/dev/null | head -1)"
  if [ -z "$token" ]; then
    log "ALERT wanted but no bot token found: $tag"
    return 1
  fi
  curl -s -m 15 "https://api.telegram.org/bot$token/sendMessage" \
    --data-urlencode "chat_id=$CHAT_ID" \
    --data-urlencode "text=$msg" \
    --data-urlencode "disable_web_page_preview=true" -o /dev/null
  log "ALERT sent to $CHAT_ID: $tag"
}

# ---------------------------------------------------------------------------
# (1) The measured path: the quota numbers Claude Code itself hands out.
# ---------------------------------------------------------------------------
# scripts/statusline-ratelimit.sh stores rate_limits.{five_hour,seven_day} on
# every status-line render (see that file for why). Percentages and reset
# timestamps beat guessing at banner wording, so this runs first and the text
# scan below stays only as a fallback for installs without the status line.
QUOTA_FILE="$STORE/.claude-rate-limits.json"
QUOTA_WARN_PCT="${QUOTA_WARN_PCT:-90}"
# Older than this and the numbers describe a window that may have reset since;
# alerting on them would cry wolf, so they are logged and skipped instead.
QUOTA_MAX_AGE_SEC="${QUOTA_MAX_AGE_SEC:-21600}"

if [ -s "$QUOTA_FILE" ] && command -v python3 >/dev/null 2>&1; then
  QUOTA_OUT="$(QUOTA_FILE="$QUOTA_FILE" QUOTA_WARN_PCT="$QUOTA_WARN_PCT" QUOTA_MAX_AGE_SEC="$QUOTA_MAX_AGE_SEC" python3 - <<'PYQ' 2>/dev/null
import json, os, time

path = os.environ["QUOTA_FILE"]
warn = float(os.environ["QUOTA_WARN_PCT"])
max_age = int(os.environ["QUOTA_MAX_AGE_SEC"])
try:
    d = json.load(open(path))
except Exception:
    raise SystemExit(0)

age = int(time.time()) - int(d.get("written_at") or 0)
if age > max_age:
    print("STALE\t%d" % age)
    raise SystemExit(0)

# Alert on crossed LEVELS, not on the raw percentage: keying the dedupe on the
# exact number would send a fresh alert for every single point from 90 to 100.
# Two levels are enough -- the heads-up, and the moment it is actually gone.
levels = sorted({100.0, warn}, reverse=True)

labels = {"five_hour": "5 oras keret", "seven_day": "heti keret"}
hits = []
for key in ("five_hour", "seven_day"):
    w = (d.get("rate_limits") or {}).get(key) or {}
    pct = w.get("used_percentage")
    if not isinstance(pct, (int, float)) or pct < warn:
        continue
    level = next((L for L in levels if pct >= L), warn)
    resets = w.get("resets_at")
    when = ""
    if isinstance(resets, (int, float)):
        when = time.strftime("%m-%d %H:%M", time.localtime(resets))
    hits.append((key, round(float(pct)), when, int(resets or 0), int(level)))

if not hits:
    raise SystemExit(0)

# Dedupe key: window + crossed level + that window's own reset timestamp. One
# alert per level per window; the next window (new resets_at) starts clean.
key = "|".join("%s:%s:%s" % (k, lv, rs) for k, _p, _w, rs, lv in hits)
lines = []
for k, p, w, _rs, _lv in hits:
    line = "%s: %d%% elhasznalva" % (labels[k], p)
    if w:
        line += " (nullazodik: %s)" % w
    lines.append(line)
print("HIT\t%s\t%s" % (key, " / ".join(lines)))
PYQ
)"
  case "$QUOTA_OUT" in
    STALE*)
      log "quota file stale ($(printf '%s' "$QUOTA_OUT" | cut -f2)s), skipping the measured path"
      ;;
    HIT*)
      QKEY="$(printf '%s' "$QUOTA_OUT" | cut -f2)"
      QTEXT="$(printf '%s' "$QUOTA_OUT" | cut -f3)"
      QSTATE="$STORE/.limit-monitor-quota-state"
      if [ "$QKEY" = "$(cat "$QSTATE" 2>/dev/null)" ]; then
        log "quota signal unchanged, already alerted"
      else
        printf '%s' "$QKEY" > "$QSTATE"
        send_alert "‼️ CLAUDE KERET ($BOT_NAME monitor)

$QTEXT

Ezt Claude nelkul mertem, a status line altal kiadott szamokbol. Ha elfogy, az agensek nem tudnak valaszolni a keret nullazodasaig." "quota:$QKEY"
      fi
      ;;
  esac
fi

# Only the bottom of a pane is inspected. The banner is printed there, while an
# ordinary conversation ABOUT limits (this monitor does get discussed in chat)
# scrolls up -- so quoted text cannot raise a false alarm.
PANE_TAIL=15

# Every fleet session, plus the main channels one explicitly so a rename is
# still followed even when tmux cannot be listed.
pane_text() {
  tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -n "$PANE_TAIL"
  tmux list-sessions -F '#{session_name}' 2>/dev/null | while read -r s; do
    [ "$s" = "$SESSION" ] && continue
    tmux capture-pane -t "$s" -p 2>/dev/null | tail -n "$PANE_TAIL"
  done
}

# Collect candidate text: recent log lines + the fleet's live tmux panes
CANDIDATE="$(
  { tail -n 200 "$STORE/channels.log" "$STORE/channels.error.log" "$STORE/dashboard.log" 2>/dev/null;
    pane_text;
  } | grep -iE "usage limit reached|reached your (usage|plan|weekly) limit|your limit will reset|approaching your usage limit|approaching[^|]*(weekly|usage) limit|[0-9]+-hour limit reached|(weekly|session) limit reached|rate_limit_error|429 too many requests|quota exceeded|out of (usage|credits)" \
    | grep -viE "rate.?limit.?error class|no rate|within limit|limit-monitor|LIMIT-FIGYELMEZT|email/nap|req/nap|/nap free|kérés/hó|/hó\b|approaching\.\*limit"
)"

if [ -z "$CANDIDATE" ]; then
  # healthy: no signal. Touch a heartbeat so we know the monitor ran.
  echo "ok $(date +%s)" > "$STORE/.limit-monitor-heartbeat"
  exit 0
fi

# Dedupe: hash the signal; only alert if new
HASH="$(printf '%s' "$CANDIDATE" | md5sum | awk '{print $1}')"
PREV="$(cat "$STATE" 2>/dev/null)"
if [ "$HASH" = "$PREV" ]; then
  log "signal unchanged, already alerted ($HASH)"
  exit 0
fi
echo "$HASH" > "$STATE"

# (2) Fallback path: text signals in the logs and the live panes.
SNIP="$(printf '%s' "$CANDIDATE" | head -3)"
MSG="⚠️ LIMIT-FIGYELMEZTETÉS ($BOT_NAME monitor)
A logokban/sessionben limit-jel jelent meg:

$SNIP

Lehet hogy közeledünk vagy elértük a Claude előfizetés keretét. Ha kell, ritkítom a heartbeatet vagy szünetet tartok. Nézd meg a sessiont ha tudod."
send_alert "$MSG" "$HASH"
