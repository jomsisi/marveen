// MSGSINK1118 (sanyiba, boss 12762/12770, Zsolt approved): the reader-pipe rule ("a reader's output must not become
// the file list of a program that acts on it", `ls <protected dir> | xargs rm`) also denied the shape CLAUDE.md
// PRESCRIBES for every inter-agent message: a quoted heredoc piped into scripts/agent-msg.sh. The body counts as the
// reader segment's text, and `bash scripts/agent-msg.sh ... -` is classified by its command word (`bash`), so the
// helper looked like a program acting on a file list.
//
// Why a false positive here is a protection regression, not an inconvenience: the SAME text passed as an ARGUMENT
// passed the gate, and in that form a backtick or $(...) inside the message runs in our own shell. The gate's
// gradient pointed at the forbidden shape, so the obvious workaround was to drop the quoting.
//
// The fix stays narrow on purpose. The exception holds ONLY while the hit comes from the heredoc body alone: when the
// reader's own words name a protected path, that file's CONTENT would leave as the message, and the deny stays.
// Deliberately NOT opened (each one is a separate decision, pinned below so a later widening is visible): dash-api.sh
// (the endpoint is chosen in the same command and the list includes /api/approvals, /api/vault, /api/schedules),
// marveen-api.sh (its prescribed form passes the text by FILE PATH anyway) and the kanban tool.
//
// >>> ONE OF THE THREE WAS OPENED SINCE, AND ONLY HALFWAY: DASHPROSESINK1124 (2026-11-24, michel 13452, boss 13453).
// dash-api.sh is a data sink on its PROSE endpoints -- /api/daily-log, /api/memories, /api/kanban/<id>/comments --
// and nowhere else. The reason written above is what made that possible rather than what blocked it: the endpoint IS
// one of the command's words, so the gate reads it, and /api/approvals, /api/vault, /api/schedules, an unknown path
// and a traversed one keep the deny. The /api/approvals row below stays in the denied table on purpose: it is the
// control that the discrimination is by ENDPOINT, not by helper. The measured false positive it fixes was ordinary
// Hungarian prose: a sentence closing a parenthesis ends `... (ket koron).`, which splits into a bare `.`.
// The full table, the trigger's three-part cause and the shapes that must stay denied:
// src/__tests__/db-write-gate-dash-api-prose-sink.test.ts. marveen-api.sh and the kanban tool are still closed.
// The decision function only reads paths: nothing here writes a real config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs module, no types
import { isPipeSink, shellWords, commandName } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
let home: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'message-sink-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'sanyiba')
  home = join(base, 'home')
  for (const d of [join(agent, '.claude-config'), join(root, 'store'), join(root, 'scripts', 'hooks'), join(home, '.claude')]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

const FREE = { deny: false }
// @R@ -> the install root, @H@ -> home. The message TEXT only MENTIONS a protected path, as a real report does.
const run = (command: string, cwd = agent) => gateDecision('Bash', { command: command.replaceAll('@R@', root).replaceAll('@H@', home) },
  { cwd, root, subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') })

const MSG = '@R@/scripts/agent-msg.sh'
const CLOSE = '@R@/scripts/agent-msg-close.sh'
// the body names a protected path from each family: the home tree and the install's own gate files
const BODY = 'The gate fires on @H@/.claude/settings.json and on @R@/scripts/hooks/db-write-gate.mjs.\nSecond line.'

describe('1. the shape CLAUDE.md prescribes: a quoted heredoc piped into the inter-agent helper', () => {
  it.each([
    // with and without `bash`, for both helpers
    `cat <<'MSG' | bash ${MSG} sanyiba boss -\n${BODY}\nMSG`,
    `cat <<'MSG' | ${MSG} sanyiba boss -\n${BODY}\nMSG`,
    `cat <<'MSG' | sh ${MSG} sanyiba boss -\n${BODY}\nMSG`,
    `cat <<'RES' | bash ${CLOSE} 12762 done -\n${BODY}\nRES`,
    // agent-msg-close.sh takes `<id> [done|failed] -`: the status is OPTIONAL
    `cat <<'RES' | bash ${CLOSE} 12762 -\n${BODY}\nRES`,
    // write the text to a file and pipe it on, in ONE bash call (the same root cause in laterRuns)
    `cat > /tmp/msg.txt <<'MSG'\n${BODY}\nMSG\ncat /tmp/msg.txt | bash ${MSG} sanyiba boss -`,
    // a text filter between the reader and the helper is still only text
    `cat <<'MSG' | sed -n 1p | bash ${MSG} sanyiba boss -\n${BODY}\nMSG`,
  ])('free: %s', (c) => { expect(run(c)).toEqual(FREE) })
})

describe('2. what the exception must NOT open', () => {
  it.each([
    // the reader's OWN words name a protected path: its CONTENT would leave as the message text
    `cat @H@/.claude/settings.json | bash ${MSG} sanyiba boss -`,
    `cat @R@/scripts/hooks/db-write-gate.mjs | bash ${MSG} sanyiba boss -`,
    // an unresolved variable in the sink: the gate cannot tell which script runs
    `cat <<'MSG' | bash $HELPER sanyiba boss -\n${BODY}\nMSG`,
    `cat <<'MSG' | bash ${MSG} $FROM boss -\n${BODY}\nMSG`,
    // the body goes to something that ACTS on it
    `cat <<'SH' | bash\ntee @H@/.claude/settings.json\nSH`,
    `cat <<'SH' | bash -s\ntee @H@/.claude/settings.json\nSH`,
    `cat <<'PY' | python3 -\nopen('@H@/.claude/settings.json', 'w').write('{}')\nPY`,
    `cat <<'X' | tee @H@/.claude/settings.json\n${BODY}\nX`,
    // the rule's original target, and its relatives
    'ls @H@/.claude | xargs rm',
    'find @H@/.claude -name settings.json | xargs sed -i s/a/b/',
    'sed -i s/a/b/ @H@/.claude/settings.json',
    // write the body to a file and RUN it in the same call
    `cat > /tmp/s.sh <<'X'\ntee @H@/.claude/settings.json\nX\nbash /tmp/s.sh`,
    // a sink that only LOOKS like the helper
    `cat <<'MSG' | bash @R@/scripts/agent-msg.sh.bak sanyiba boss -\n${BODY}\nMSG`,
    `cat <<'MSG' | bash @R@/scripts/not-agent-msg.sh sanyiba boss -\n${BODY}\nMSG`,
    // DELIBERATELY not opened: separate decisions, not this fix. dash-api.sh was opened on its PROSE endpoints by
    // DASHPROSESINK1124; /api/approvals stays here as the control that the discrimination is by ENDPOINT.
    `cat <<'JSON' | bash @R@/scripts/dash-api.sh POST /api/approvals\n{"content":"${BODY.split('\n')[0]}"}\nJSON`,
    `cat <<'JSON' | bash @R@/scripts/dash-api.sh POST /api/vault\n{"content":"${BODY.split('\n')[0]}"}\nJSON`,
    `cat <<'MSG' | bash @R@/scripts/marveen-api.sh message sanyiba boss -\n${BODY}\nMSG`,
    `cat <<'MSG' | python3 @R@/scripts/kartya-es-ertesites.py komment --kartya x --szoveg-stdin\n${BODY}\nMSG`,
  ])('denied: %s', (c) => { expect(run(c).deny).toBe(true) })
})

describe('3. a reader piped into a reader stays free, and the helper is matched by its script path', () => {
  it('the positive control of the whole table: ls | cat is not a program acting on the list', () => {
    expect(run('ls @H@/.claude | cat')).toEqual(FREE)
  })

  it.each([
    ['bash /x/scripts/agent-msg.sh a b -', true],
    ['bash /x/scripts/agent-msg-close.sh 1 done -', true],
    ['scripts/agent-msg.sh a b -', true],
    ['bash /x/scripts/agent-msg.sh.bak a b -', false],
    ['bash /x/scripts/marveen-api.sh message a b -', false],
    // still false here, and that is not a leftover: DASHPROSESINK1124 added a SEPARATE predicate
    // (isDashApiProseSink), used at the one reader-pipe site, so this sink list and laterRuns keep their reading
    ['bash /x/scripts/dash-api.sh POST /api/daily-log', false],
    ['bash $HELPER a b -', false],
  ])('isPipeSink(%s) -> %s', (cmd, want) => {
    const w = shellWords(cmd as string)
    expect(isPipeSink(w, commandName(w))).toBe(want)
  })
})
