#!/usr/bin/env bash
# host-restart-watchdog.sh
#
# Fires once at every user-manager start (oneshot, WantedBy=default.target).
# Under WSL2 the whole utility VM can shut down and re-boot (vmIdleTimeout
# auto-shutdown, Windows sleep/resume, `wsl --shutdown`), which tears down the
# kernel + system/user systemd + tmux + dashboard + channels all at once and is
# NOT an application crash. This watchdog detects that host/VM restart via the
# kernel boot time (/proc/stat btime) and sends ONE Telegram notice that names
# it as a host/WSL-VM restart (with an estimated downtime), so a fleet-wide
# silence is never mistaken for a CostOps/app crash.
#
# App/service crashes do NOT change btime and never trigger this script -- they
# are reported separately by the OnFailure= drop-ins (marveen-notify@.service).
# That split is the whole point: btime-change => host restart; OnFailure => app.
#
# Safe by construction: read-only except for the state file; Telegram send is
# best-effort; the script always exits 0 so the oneshot unit never enters
# `failed` (a failing watchdog would itself look like an incident).

set -uo pipefail

STATE_DIR="${MARVEEN_STORE:-$HOME/marveen/store}"
STATE_FILE="$STATE_DIR/.last-btime"
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
# Alert target chat-id -- MUST come from the install's own config; there is
# deliberately NO hardcoded fallback (a hardcoded id would make every downstream
# install send its host-stability alerts to that one private chat).
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"

log() { echo "[host-restart-watchdog] $*"; }

# Real WSL check -- only under WSL is a whole-VM reboot the expected surprise;
# on a bare-metal/other Linux host a btime change is an ordinary reboot, so we
# word the alert accordingly instead of always claiming "WSL VM restarted".
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null \
   || [[ -n "${WSL_DISTRO_NAME:-}" ]] || [[ -e /run/WSL ]]; then
  HOST_KIND="WSL VM"
else
  HOST_KIND="host"
fi

# Current kernel boot epoch (changes only on a real (re)boot of the VM/host).
btime="$(awk '/^btime/{print $2}' /proc/stat 2>/dev/null)"
if [[ -z "${btime:-}" ]]; then
  log "no btime in /proc/stat; nothing to do"
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true
prev=""
[[ -f "$STATE_FILE" ]] && prev="$(tr -dc '0-9' <"$STATE_FILE" 2>/dev/null)"

# Persist the current btime for the next run no matter what happens below.
echo "$btime" >"$STATE_FILE" 2>/dev/null || true

if [[ -z "$prev" ]]; then
  log "baseline initialised (btime=$btime); no alert on first run"
  exit 0
fi

if [[ "$prev" == "$btime" ]]; then
  log "btime unchanged ($btime) -- user-manager restart without a host reboot; no alert"
  exit 0
fi

# --- host/VM restart detected (btime changed) ---
boot_local="$(date -d "@$btime" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo "@$btime")"

# A KIESES HOSSZA A NAPLOBOL JON, NEM FAJL-IDOBELYEGEKBOL (javitva 2026-08-27).
#
# A REGI BECSLES SZERKEZETILEG ROSSZ VOLT, es MINDIG a riaszto iranyba tevedett.
# A `store/*.log` fajlok kozul a `m < btime` szurovel a LEGFRISSEBBET vette
# "utolso eletjel"-nek. Csakhogy minden naplo, ami a fagyas pillanataban ELO
# volt, a boot utan MASODPERCEKEN BELUL ujra irodik -- tehat a szuro pontosan
# azokat zarja ki, amelyek valaszolnanak. Ami marad, az a HALOTT naplok
# halmaza, es a legfrissebb halott naplo tetszolegesen regi lehet.
# MERVE a 2026-08-27-i kiesesnel: a riasztas ~1038 percet mondott
# (`egress-blocked.log`, elozo nap 16:18), a VALODI kieses 508 perc volt.
# Ketszeres tulbecsles, es nem veletlenul: a hiba iranya allando.
#
# A NAPLO KOZVETLENUL VALASZOL: az elozo boot UTOLSO bejegyzese az a pillanat,
# amikor a gep meg elt. Ez meres, nem proxy.
gap_txt="ismeretlen"
halal_ok=""
last_alive="$(journalctl -b -1 -n 1 --output=short-unix --no-pager 2>/dev/null | tail -1 | cut -d. -f1)"
if [[ "${last_alive:-}" =~ ^[0-9]+$ ]] && (( last_alive > 0 && last_alive < btime )); then
  gap_min=$(( (btime - last_alive) / 60 ))
  last_txt="$(date -d "@$last_alive" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '?')"
  gap_txt="${gap_min} perc (utolsó naplóbejegyzés: ${last_txt})"
  # AZ UTOLSO SOR MAGA IS INFORMACIO: 2026-08-27-en ez nevezte meg az okot
  # (i915 kernel-hiba), es enelkul a cimzett csak annyit tudott volna, hogy
  # "ujraindult". Levagva, hogy egy hosszu sor ne nyelje el az uzenetet.
  halal_ok="$(journalctl -b -1 -n 1 --no-pager 2>/dev/null | tail -1 | cut -c1-160)"
else
  # NEM adunk vissza becslest, ha nem tudjuk megmerni. Egy rossz szam rosszabb,
  # mint a hianya: a cimzett cselekedne ra, es senki nem ellenorizne.
  gap_txt="nem mérhető (a rendszernapló nem adott előző bootot)"
fi

msg="Marveen ${HOST_KIND} restarted.
Új boot: ${boot_local}
Kiesés: ${gap_txt}${halal_ok:+
Az utolsó naplósor a leállás előtt: ${halal_ok}}
(Ez host/VM szintű restart, NEM app-crash. A dashboard/channels app-crash külön OnFailure-értesítést küld.)"

log "host restart detected: prev btime=$prev new=$btime; sending Telegram"

# Best-effort Telegram send. Never let a send failure fail the unit.
token=""
if [[ -f "$ENV_FILE" ]]; then
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
fi
if [[ -n "$token" && -n "$CHAT_ID" ]]; then
  # A curl EXIT-KODJA NEM MERES: 0-val ter vissza akkor is, ha a Telegram
  # ELUTASITOTTA a kerest (400 chat not found, 401 rossz token). A regi
  # `>/dev/null && log "Telegram sent"` alak ezert egy NEMA kudarcot is
  # sikernek naplozott -- pont abban a szkriptben, aminek az a dolga, hogy
  # szoljon. Az egyetlen bizonyitek a valasz `"ok":true` mezoje.
  resp="$(curl -s --max-time 15 \
    "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${msg}" 2>/dev/null)"
  if [[ "$resp" == *'"ok":true'* ]]; then
    log "Telegram sent (a Telegram visszaigazolta: ok=true)"
  else
    # A hibaokot IS naploznunk kell, kulonben a kovetkezo olvaso a halozatra
    # gyanakszik, holott tipikusan egy rossz chat_id vagy lejart token az ok.
    # A valasz nem tartalmaz tokent, tehat naplozhato.
    log "Telegram send FAILED -- a valasz: ${resp:-<ures: nincs HTTP valasz>}"
  fi
else
  log "skipping Telegram (${HOST_KIND} restart still logged): missing${token:+}$( [[ -z "$token" ]] && echo ' TELEGRAM_BOT_TOKEN(via TELEGRAM_ENV)')$( [[ -z "$CHAT_ID" ]] && echo ' MARVEEN_ALERT_CHAT_ID')"
fi

exit 0
