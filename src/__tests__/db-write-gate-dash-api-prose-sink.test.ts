// DASHPROSESINK1124 (michel 13452, boss 13453, measured by sanyiba): the reader-pipe rule denied the shape every
// CLAUDE.md PRESCRIBES for the daily log, the memory writes and the kanban comments -- a quoted heredoc piped into
// scripts/dash-api.sh -- on ordinary Hungarian prose that names no path at all.
//
// THE MEASURED CAUSE IS A CONJUNCTION OF THREE, and no single one of them is a bug:
//   (1) a Hungarian sentence that closes a parenthesis ends `... (ket koron).`, and the word reader splits on `()`,
//       so a BARE `.` becomes one of the text's words;
//   (2) `.` is a TARGET_SEGMENT_NAME (it has to be: `cd ~/.claude && rm -rf .` must stay denied), and in an agent's
//       OWN directory `.` resolves to a cwd that CONTAINS a protected path -> an 'ancestor' hit. One directory
//       deeper (agents/michel/ausztria) nothing protected is below, so the SAME text passed from there;
//   (3) every other branch of installFileDeny's segment loop already lets an ancestor-only hit pass
//       (`hits.every((h) => h.kind === 'ancestor') && !DIR_CHANGERS.has(name)`), but the reader-pipe branch returns
//       before reaching that rule.
// michel measured 21 probe calls to pin it: the body alone does not decide (the same body passed from a deeper cwd),
// the cwd alone does not decide (a one-word body passed from the same cwd), and the `##` header, the `12:44 - 1521`
// shape, a parenthesised clause, the word "melleklet" and the sheer length each failed separately.
//
// WHY THE FIX IS THE ENDPOINT, AND NOT (1) OR (3). Removing `.` from the segment names blinds the gate to `rm -rf .`;
// exempting ancestor-only hits in the reader-pipe branch would let `cat <<'X' | xargs rm -rf` with a body of `.`
// through, which is the rule's original target (both pinned below). What is left is the sink: dash-api.sh hands its
// stdin to `curl -d` and does nothing else with it. MSGSINK1118 left it closed with a stated reason -- "the endpoint
// is chosen in the same command and the list includes /api/approvals, /api/vault, /api/schedules" -- and that reason
// is the discriminator: the endpoint is one of the command's own words, so the gate reads it, and only the three
// prose endpoints are a sink.
// The decision function only reads paths: nothing here writes a real config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs module, no types
import { isDashApiProseSink, shellWords, commandName } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
let deeper: string
let home: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dash-prose-sink-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'sanyiba')
  deeper = join(agent, 'munka')
  home = join(base, 'home')
  for (const d of [join(agent, '.claude'), join(agent, '.claude-config'), deeper, join(root, 'store'),
    join(root, 'scripts', 'hooks'), join(home, '.claude')]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  writeFileSync(join(agent, '.claude', 'settings.json'), '{}')
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

const FREE = { deny: false }
// @R@ -> the install root, @H@ -> home.
const run = (command: string, cwd?: string) => gateDecision('Bash', { command: command.replaceAll('@R@', root).replaceAll('@H@', home) },
  { cwd: cwd ?? agent, root, subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') })

const DASH = '@R@/scripts/dash-api.sh'
// THE TRIGGER, byte for byte: a sentence that closes a parenthesis and ends with a period. Names no path.
const PROZA = '## Kor lefutott\\nA kapu igazolva (ket koron).'
const body = (s: string) => `{"agent_id":"sanyiba","content":"${s}"}`

describe('1. the positive control: the trigger is LIVE in this fixture', () => {
  // This control shares the failure mode being tested -- same body, same cwd, same helper, ONLY the endpoint differs.
  // Without it the table below would pass even if the fixture never produced the 'ancestor' hit at all, and every
  // "free" row would prove nothing (sanyiba, 2026-11-24: a control that cannot fail for the same reason is only a
  // second green tick).
  it('the same prose, the same cwd, a NON-prose endpoint: denied', () => {
    expect(run(`cat <<'JSON' | bash ${DASH} POST /api/schedules\n${body(PROZA)}\nJSON`).deny).toBe(true)
  })
  it('and the trigger is the bare `.`: the same sentence WITHOUT it passes even there', () => {
    expect(run(`cat <<'JSON' | bash ${DASH} POST /api/schedules\n${body('A kapu igazolva (ket koron)')}\nJSON`)).toEqual(FREE)
  })
  it('and it needs a cwd that CONTAINS a protected path: from one directory deeper it passes', () => {
    expect(run(`cat <<'JSON' | bash ${DASH} POST /api/schedules\n${body(PROZA)}\nJSON`, deeper)).toEqual(FREE)
  })
})

describe('2. the shapes CLAUDE.md prescribes are free', () => {
  it.each([
    // the daily log, with the helper spelled absolute and relative, with and without `bash`
    `cat <<'JSON' | bash ${DASH} POST /api/daily-log\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash scripts/dash-api.sh POST /api/daily-log\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | sh ${DASH} POST /api/daily-log\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | ${DASH} POST /api/daily-log\n${body(PROZA)}\nJSON`,
    // the memory write and the kanban comment
    `cat <<'JSON' | bash ${DASH} POST /api/memories\n{"agent_id":"sanyiba","content":"${PROZA}","category":"cold"}\nJSON`,
    `cat <<'JSON' | bash ${DASH} POST /api/kanban/ugyeleti-kartya/comments\n{"author":"sanyiba","content":"${PROZA}"}\nJSON`,
    `cat <<'JSON' | bash ${DASH} POST /api/kanban/0e9c47e5/comments\n{"author":"sanyiba","content":"${PROZA}"}\nJSON`,
    // a log entry that QUOTES a protected path, which is what a report about the gates looks like (already allowed
    // for the message helpers by MSGSINK1118, and the hit still comes from the body alone)
    `cat <<'JSON' | bash ${DASH} POST /api/daily-log\n${body('A kapu a @R@/scripts/hooks/db-write-gate.mjs fajlban all.')}\nJSON`,
    `cat <<'JSON' | bash ${DASH} POST /api/daily-log\n${body('A @H@/.claude/settings.json nem irhato.')}\nJSON`,
    // a text filter between the reader and the helper is still only text
    `cat <<'JSON' | sed -n 1p | bash ${DASH} POST /api/daily-log\n${body(PROZA)}\nJSON`,
  ])('free: %s', (c) => { expect(run(c)).toEqual(FREE) })
})

describe('3. what the exception must NOT open', () => {
  it.each([
    // NOT a prose endpoint: these three are exactly the reason MSGSINK1118 left the helper closed
    `cat <<'JSON' | bash ${DASH} POST /api/approvals\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash ${DASH} POST /api/vault\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash ${DASH} POST /api/schedules\n${body(PROZA)}\nJSON`,
    // a schedule whose command would write a protected path: denied on the path, not only on the endpoint
    `cat <<'JSON' | bash ${DASH} POST /api/schedules\n{"name":"x","type":"command","command":"rm -rf @R@/scripts/hooks"}\nJSON`,
    // an unknown or traversed endpoint is not a sink, by construction
    `cat <<'JSON' | bash ${DASH} POST /api/daily-log/../vault\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash ${DASH} POST /api/ismeretlen\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash ${DASH} POST /api/kanban/abc123\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash ${DASH} PUT /api/daily-log\n${body(PROZA)}\nJSON`,
    // the reader's OWN words name a protected path: its CONTENT would leave as the entry's text
    `cat @H@/.claude/settings.json | bash ${DASH} POST /api/daily-log`,
    `cat @R@/scripts/hooks/db-write-gate.mjs | bash ${DASH} POST /api/daily-log`,
    // an unresolved variable: the gate cannot tell which script runs or which endpoint it writes
    `cat <<'JSON' | bash $HELPER POST /api/daily-log\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash ${DASH} POST /api/daily-log$SUFFIX\n${body(PROZA)}\nJSON`,
    // ...and an unresolved PREFIX, which the path regexes alone do NOT catch: `$WT/scripts/dash-api.sh` ends with
    // `/scripts/dash-api.sh`, so only the no-expansion rule refuses it. Added because the mutation run found the
    // guard unpinned: dropping it failed no test, since both rows above are refused one step earlier.
    `cat <<'JSON' | bash $WT/scripts/dash-api.sh POST /api/daily-log\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash \${ROOT}/scripts/dash-api.sh POST /api/memories\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash /x*/scripts/dash-api.sh POST /api/daily-log\n${body(PROZA)}\nJSON`,
    // a third argument: the helper itself refuses it, so this is another program's argument list
    `cat <<'JSON' | bash ${DASH} POST /api/daily-log @R@/scripts/hooks\n${body(PROZA)}\nJSON`,
    // a sink that only LOOKS like the helper
    `cat <<'JSON' | bash @R@/scripts/dash-api.sh.bak POST /api/daily-log\n${body(PROZA)}\nJSON`,
    `cat <<'JSON' | bash @R@/scripts/not-dash-api.sh POST /api/daily-log\n${body(PROZA)}\nJSON`,
    // the body goes to something that ACTS on it -- the reader-pipe rule's original targets, with the SAME bare `.`
    "cat <<'SH' | bash\nrm -rf .\nSH",
    "cat <<'X' | xargs rm -rf\n.\nX",
    'ls @H@/.claude | xargs rm',
    // still closed on purpose, each its own decision (pinned so a later widening is visible)
    `cat <<'MSG' | bash @R@/scripts/marveen-api.sh daily-log sanyiba -\n${PROZA}\nMSG`,
    `cat <<'MSG' | python3 @R@/scripts/kartya-es-ertesites.py komment --kartya x --szoveg-stdin\n${PROZA}\nMSG`,
  ])('denied: %s', (c) => { expect(run(c).deny).toBe(true) })
})

describe('4. isDashApiProseSink reads the helper AND the endpoint', () => {
  it.each([
    ['bash /x/scripts/dash-api.sh POST /api/daily-log', true],
    ['bash /x/scripts/dash-api.sh POST /api/memories', true],
    ['bash /x/scripts/dash-api.sh POST /api/kanban/abc123/comments', true],
    ['sh /x/scripts/dash-api.sh POST /api/daily-log', true],
    ['scripts/dash-api.sh POST /api/daily-log', true],
    ['/x/scripts/dash-api.sh POST /api/memories', true],
    ['bash /x/scripts/dash-api.sh POST /api/approvals', false],
    ['bash /x/scripts/dash-api.sh POST /api/vault', false],
    ['bash /x/scripts/dash-api.sh POST /api/schedules', false],
    ['bash /x/scripts/dash-api.sh POST /api/daily-log/../vault', false],
    ['bash /x/scripts/dash-api.sh POST /api/kanban/abc123', false],
    ['bash /x/scripts/dash-api.sh POST /api/kanban/x/comments/extra', false],
    ['bash /x/scripts/dash-api.sh PUT /api/daily-log', false],
    ['bash /x/scripts/dash-api.sh DELETE /api/memories', false],
    ['bash /x/scripts/dash-api.sh POST', false],
    ['bash /x/scripts/dash-api.sh POST /api/daily-log extra', false],
    ['bash /x/scripts/dash-api.sh.bak POST /api/daily-log', false],
    ['bash /x/scripts/not-dash-api.sh POST /api/daily-log', false],
    ['bash /x/scripts/agent-msg.sh a b -', false],
    ['bash $HELPER POST /api/daily-log', false],
    ['bash /x/scripts/dash-api.sh POST /api/daily-log$X', false],
    // an unresolved PREFIX still ends with the helper's path: refused by the no-expansion rule alone
    ['bash $WT/scripts/dash-api.sh POST /api/daily-log', false],
    ['bash ${ROOT}/scripts/dash-api.sh POST /api/memories', false],
    ['bash /x*/scripts/dash-api.sh POST /api/daily-log', false],
  ])('isDashApiProseSink(%s) -> %s', (cmd, want) => {
    const w = shellWords(cmd as string)
    expect(isDashApiProseSink(w, commandName(w))).toBe(want)
  })
})
