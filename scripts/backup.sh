#!/usr/bin/env bash
# Marveen backup.
#
# The archive has two top-level groups so a restore is unambiguous about
# where each file belongs (see docs/MIGRATION.md):
#
#   repo/   -> extract under the project root (this repo)
#     store/claudeclaw.db (+ -shm/-wal; WAL-checkpointed before copy)
#     store/.dashboard-token   (dashboard bearer)
#     .env                     (project root secrets)
#     scheduled-tasks.json     (legacy, if present)
#     assets/meetings/**       (meeting transcripts/memos)
#     store/hirlevel-lista, store/reports          (personal data: LOCAL package only)
#     scripts/browser/**, scripts/trafik-postafiok-figyeles.sh
#     store/mennyiseg-meres/*.py|cjs               (the scripts, not the raw store data)
#     agents/*/memory/**                           (per-agent memory pages)
#     agents/*/CLAUDE.md, SOUL.md, .mcp.json
#     agents/*/.claude/channels/{telegram,slack,discord}/.env, access.json
#
#   home/   -> extract under $HOME
#     .claude/skills/**            (the self-built skill library)
#     .claude/scheduled-tasks/**   (file-based scheduled tasks: SKILL.md + config)
#     .claude/projects/*/memory/** (the file-backed memory store; LOCAL package only)
#     .claude/channels/*/.env      (MAIN orchestrator channel token)
#     .claude/channels/*/access.json, invites.json, approved/**  (pairing state)
#     Library/LaunchAgents/com.<MAIN_AGENT_ID>.*.plist (launchd jobs)
#
# KNOWN GAP, measured 2026-09-18, left here on purpose so the next reader inherits the
# question and not just the answer: the lines above name PLACES, and a place is narrower
# than the idea behind it. `agents/*/CLAUDE.md, SOUL.md` covers every sub-agent's identity
# file and misses the main agent's, because the root CLAUDE.md and SOUL.md do not live
# under agents/. Same shape across the tree: 58 gitignored, untracked files are in no
# archive, 45 of them under scripts/ -- including the homoglyph gate the whole fleet runs
# and the backup scripts themselves. They are gitignored on purpose (this repo is public),
# so git is not a second copy for them either.
# Deliberately NOT proposed for inclusion: `.env.bak.*` and `*.bak-*`. Those are stale
# copies, and the .env ones carry secrets the live .env already covers -- widening a backup
# to "everything that is missing" is the same list-thinking in the other direction. The
# scope is two filters, not one: what would have to be rebuilt, AND what must not leak.
# If the scope is widened, rewrite these lines as CONCEPTS, or the next widening will copy
# the place again -- and code agreeing with a comment is two copies of one assumption, not
# a confirmation.
#
# Output: backups/claudeclaw-YYYYmmdd-HHMMSS.tar.gz
# Retention: keeps the most recent 14 archives, prunes the rest.
#
# Restore (preserve modes so the 0600 token files stay private):
#   tar -xpzf <archive> -C /tmp/restore        # inspect first
#   then copy repo/* into the project root and home/* into $HOME.
# Full runbook: docs/MIGRATION.md.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${REPO_ROOT}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/claudeclaw-${STAMP}.tar.gz"
KEEP=14

mkdir -p "${BACKUP_DIR}"
cd "${REPO_ROOT}"

# Checkpoint WAL into the main DB file so the snapshot is self-contained.
# Tolerate a missing sqlite3 CLI -- just fall back to copying the files as-is.
if [[ -f store/claudeclaw.db ]] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 store/claudeclaw.db 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null || true
fi

# --- Build the two path lists (each relative to its own base). -------------
# tar refuses missing entries, which would fail the whole backup on a fresh
# machine (no agents yet) -- so we only list paths that actually exist.
REPOLIST="$(mktemp -t claudeclaw-repo.XXXXXX)"
HOMELIST="$(mktemp -t claudeclaw-home.XXXXXX)"
MANIFEST="$(mktemp -t claudeclaw-manifest.XXXXXX)"
STAGE="$(mktemp -d -t claudeclaw-stage.XXXXXX)"
trap 'rm -f "${REPOLIST}" "${HOMELIST}" "${MANIFEST}"; rm -rf "${STAGE}"' EXIT

# add_if <listfile> <base> <relpath>  -- append relpath when <base>/<relpath> exists.
add_if() {
  local list="$1" base="$2" rel="$3"
  if [[ -e "${base}/${rel}" ]]; then echo "${rel}" >> "${list}"; fi
}

# repo/ group (relative to REPO_ROOT)
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db-shm
add_if "${REPOLIST}" "${REPO_ROOT}" store/claudeclaw.db-wal
add_if "${REPOLIST}" "${REPO_ROOT}" store/.dashboard-token
add_if "${REPOLIST}" "${REPO_ROOT}" store/config-overrides.json
# Potolhatatlan, NEM ujraeloallithato store-tartalom (2026-09-08, Zsolt jovahagyasa,
# Telegram 3434). SZANDEKOSAN csak EBBE a csomagba kerul: a hirlevel-lista SZEMELYES
# ADAT, a munkaadat-mentes pedig felhobe (OneDrive) megy es titok-mentesnek kell
# maradnia. A mi-club-export KIMARAD: 370 MB, es a MI Clubbol barmikor ujraletoltheto.
add_if "${REPOLIST}" "${REPO_ROOT}" store/hirlevel-lista
add_if "${REPOLIST}" "${REPO_ROOT}" store/reports
# EGY FUTO AUTOMATIZMUS EGYETLEN PELDANYA (safar merte ki 2026-09-16, boss visszamerte).
# Ezek a fajlok a `.gitignore` `scripts/*.sh|mjs` es `store/` szabalyai ala esnek, tehat NINCS
# verziokovetesuk, es eddig egyik mentes sem vitte oket. A `webmail-erkezettek.mjs`-t HAROM
# utemezett feladat hivja (sajat-postafiok-valasz-figyeles, evedd-ugyeleti-jelentes,
# trafik-jelentes-postafiok-figyeles) -- ha elveszik, mindharom NEMAN elhal.
add_if "${REPOLIST}" "${REPO_ROOT}" scripts/trafik-postafiok-figyeles.sh
add_if "${REPOLIST}" "${REPO_ROOT}" scripts/browser
# A `mennyiseg-meres` konyvtarbol CSAK A SZKRIPT megy, a nyers bolti adat NEM: az ~10 MB naponta,
# ujraeloallithato a boltbol, es ugyanaz a titok-kerdes all ra, amit a `store/*.csv`-nel mar
# felvetettunk. A szkript viszont potolhatatlan (pl. az `ar-elteres-boltok-kozott.cjs` hordozza
# a nem-GTIN kizarasi szabalyt).
if [[ -d "${REPO_ROOT}/store/mennyiseg-meres" ]]; then
  ( cd "${REPO_ROOT}" && find store/mennyiseg-meres -type f \( -name '*.py' -o -name '*.cjs' \) -print ) >> "${REPOLIST}"
fi
add_if "${REPOLIST}" "${REPO_ROOT}" .env
add_if "${REPOLIST}" "${REPO_ROOT}" scheduled-tasks.json
add_if "${REPOLIST}" "${REPO_ROOT}" assets/meetings
# Per-agent identity + channel secrets (glob; missing dir is not an error).
if [[ -d agents ]]; then
  find agents -type f \
    \( -name 'CLAUDE.md' -o -name 'SOUL.md' -o -name '.mcp.json' \
       -o -name 'access.json' -o -name '.env' \) \
    -print >> "${REPOLIST}"
fi

# Per-agent memory pages. Same reason as the shared store below, and they need their
# own line because they live in the REPO, not under $HOME -- and `.gitignore` covers
# them, so git is not a second copy either. Five dirs, one page each today.
if [[ -d agents ]]; then
  find agents -mindepth 2 -maxdepth 2 -type d -name 'memory' -print >> "${REPOLIST}"
fi

# home/ group (relative to $HOME)
add_if "${HOMELIST}" "${HOME}" .claude/skills
add_if "${HOMELIST}" "${HOME}" .claude/scheduled-tasks
# The file-backed memory store (2026-09-18, Zsolt's approval on Telegram 3733;
# safar measured the gap on 09-17). These pages are what actually loads into every
# session, so they are the layer that changes behaviour -- and until today they had
# NO copy anywhere: neither this archive nor the OneDrive one matched
# `projects/*/memory/`, and the SQLite mirror is a side effect, not a backup (it
# reformats frontmatter as prose, is line-resolution, and drops one page that trips
# the dashboard's injection filter).
#
# INTENTIONALLY LOCAL-ONLY: 12 pages contain e-mail addresses, so the store is
# personal data -- the same classification that keeps `store/hirlevel-lista` out of
# the cloud package (see the comment above it). `backup-munkaadat.sh` copies only
# skills/ and scheduled-tasks/ from $HOME, so it stays out of the cloud by
# construction; do not widen it there.
#
# GLOB, NOT A HARDCODED PATH: a new agent's project dir would otherwise be left out
# silently, with nothing to signal it.
if [[ -d "${HOME}/.claude/projects" ]]; then
  ( cd "${HOME}" && find .claude/projects -mindepth 2 -maxdepth 2 -type d -name 'memory' -print ) >> "${HOMELIST}"
fi
# MAIN orchestrator channel tokens + pairing state, per provider. bot.pid and
# inbox/ are runtime/transient and intentionally excluded.
if [[ -d "${HOME}/.claude/channels" ]]; then
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 \
      \( -name '.env' -o -name 'access.json' -o -name 'invites.json' \) \
      -print ) >> "${HOMELIST}"
  ( cd "${HOME}" && find .claude/channels -maxdepth 2 -type d -name 'approved' -print ) >> "${HOMELIST}"
fi
# launchd jobs for this fleet. The job labels are com.<MAIN_AGENT_ID>.<service>
# (see src/web/main-agent.ts), so resolve MAIN_AGENT_ID the way the app does
# (src/env.ts: read from .env, default "marveen" when unset) instead of
# hardcoding one deployment's prefix. Parsing mirrors env.ts: last definition
# wins, surrounding matching quotes stripped.
MAIN_AGENT_ID="marveen"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  # `|| true`: with `set -o pipefail`, a no-match grep would otherwise fail the
  # whole substitution (and, under `set -e`, abort the backup) on any install
  # that leaves MAIN_AGENT_ID unset and relies on the "marveen" default.
  _mid="$(grep -E '^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=' "${REPO_ROOT}/.env" | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/' || true)"
  [[ -n "${_mid}" ]] && MAIN_AGENT_ID="${_mid}"
fi
if [[ -d "${HOME}/Library/LaunchAgents" ]]; then
  ( cd "${HOME}" && find Library/LaunchAgents -maxdepth 1 -name "com.${MAIN_AGENT_ID}.*.plist" -print ) >> "${HOMELIST}"
fi

if [[ ! -s "${REPOLIST}" && ! -s "${HOMELIST}" ]]; then
  echo "backup: nothing to archive" >&2
  exit 0
fi

# --- Manifest (stored at the archive root for self-description). -----------
{
  echo "Marveen backup ${STAMP}"
  echo "host: $(hostname 2>/dev/null || echo '?')   user: ${USER:-?}   home: ${HOME}"
  echo "repo root: ${REPO_ROOT}"
  echo "Restore: tar -xpzf <archive> -C <tmp>; copy repo/* -> project root, home/* -> \$HOME."
  echo "See docs/MIGRATION.md for the full runbook (TCC, launchd paths, one-bot-one-poller, venv rebuild)."
  echo "--- repo/ ---"; sed 's,^,repo/,' "${REPOLIST}" 2>/dev/null || true
  echo "--- home/ ---"; sed 's,^,home/,' "${HOMELIST}" 2>/dev/null || true
} > "${MANIFEST}"

# --- Assemble the archive via a staging dir, then one plain tar. -----------
# The repo/ and home/ groups are produced by copying into a staging tree, NOT
# by tar name-substitution: bsdtar's `-s` and GNU tar's `--transform` are
# mutually incompatible (on GNU tar, `-s` is `--same-order` and takes no
# argument), so a substitution-based build is not portable. Staging + a single
# `tar -czf -C "${STAGE}" .` works identically on macOS (bsdtar) and Linux
# (GNU tar). Everything backed up is small (a few MB), so the copy is cheap;
# `cp -pR` preserves modes so the 0600 token files stay private.
cp "${MANIFEST}" "${STAGE}/MANIFEST.txt"

stage_group() {  # stage_group <listfile> <base> <group>
  local list="$1" base="$2" group="$3" rel parent
  [[ -s "${list}" ]] || return 0
  while IFS= read -r rel; do
    [[ -z "${rel}" ]] && continue
    parent="$(dirname "${rel}")"
    mkdir -p "${STAGE}/${group}/${parent}"
    cp -pR "${base}/${rel}" "${STAGE}/${group}/${parent}/"
  done < "${list}"
}

stage_group "${REPOLIST}" "${REPO_ROOT}" repo
stage_group "${HOMELIST}" "${HOME}" home

# Archive only the top-level entries that exist (a group dir is absent when
# its list was empty), so tar never errors on a missing entry and the names
# stay clean (no leading "./").
( cd "${STAGE}" && tar -czf "${ARCHIVE}" MANIFEST.txt \
    $( [[ -d repo ]] && echo repo ) $( [[ -d home ]] && echo home ) )
echo "backup: wrote ${ARCHIVE} ($(wc -c < "${ARCHIVE}" | awk '{print $1}') bytes)"

# The archive contains sensitive tokens (dashboard bearer, channel bot tokens,
# project .env secrets). Do not auto-sync ${BACKUP_DIR} to iCloud, Dropbox,
# Google Drive, or any other cloud-backup folder. Keep it local.
echo "backup: WARNING -- archive contains sensitive tokens; keep ${BACKUP_DIR} out of cloud-sync folders (iCloud / Dropbox / Google Drive)." >&2

# Keep the newest ${KEEP} archives, drop the rest. while-read (not mapfile)
# for macOS bash 3.2 compatibility.
ls -1t "${BACKUP_DIR}"/claudeclaw-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  [[ -z "${f}" ]] && continue
  rm -f "${f}"
  echo "backup: pruned $(basename "${f}")"
done
