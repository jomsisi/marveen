// HEREDOCPUNCT1118 (sanyiba, boss 12801/12803): in a LITERAL heredoc body a bare `.`, `..` or `~` token is sentence
// punctuation, not a path name. Measured minimal shape: `x).` denies, `x),` and `x):` pass -- so it is the `)` + `.`
// PAIR. The `)` ends the parsed segment, the following `.` becomes a standalone word, and `TARGET_SEGMENT_NAMES` holds
// '.', '..' and '~' (correctly, for a real command: `cd ~/.claude && rm -rf .`). Hungarian technical prose ends
// sentences with a parenthetical constantly, so this fired on an ordinary daily-log entry.
//
// The fix sits in literalHeredocBody only, NOT in the shared literalWords: literalQuotedGlobs applies that to the
// segment's OWN quoted spans, and there a quoted `"."` IS the path the command acts on. INSTRFILES1104 already states
// the same principle for globs (with nothing re-running the text as shell code, a body is data), so this is that rule's
// analogue, not a new one.
//
// >>> AND THE SCOPE, STATED SO NOBODY READS THIS AS A FULL FIX: this is NECESSARY BUT NOT SUFFICIENT for the reported
// case. The form CLAUDE.md prescribes is `cat <<'JSON' | bash scripts/dash-api.sh POST /api/daily-log`, and
// reShellsText (db-write-gate.mjs:562) splits the WHOLE command into words: the word `bash` puts the command in the
// re-shelling class, so the body never reaches the literal path at all. That is the same root cause as PR #3 (`bash
// <script>` classified by its command word), it governs glob literalization across the gate, and it was left out of
// this change on purpose. The last two cases below PIN that remaining gap: when it is fixed, they fail loudly and must
// be flipped knowingly.
// The decision function only reads paths: nothing here writes a real config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, literalHeredocBody, literalQuotedGlobs } from '../../scripts/hooks/db-write-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
let home: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'heredoc-punct-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'sanyiba')
  home = join(base, 'home')
  for (const d of [join(agent, '.claude-config'), join(root, 'store'), join(root, 'scripts'), join(home, '.claude')]) {
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
const run = (command: string, cwd = agent) => gateDecision('Bash', { command: command.replaceAll('@R@', root).replaceAll('@H@', home) },
  { cwd, root, subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') })

const PROSE = 'Egy mondat (zarojelben valami). Masodik mondat.'
const BODY = `{"agent_id":"sanyiba","content":"${PROSE}"}`

describe('1. literalHeredocBody: a bare punctuation word is not a path, a path-like word still is', () => {
  it('neutralises a standalone . / .. / ~', () => {
    expect(literalHeredocBody('Egy mondat (valami). Masodik.')).toBe('Egy mondat (valami)_ Masodik.')
    expect(literalHeredocBody('ket pont .. es egy tilde ~ kozott')).toBe('ket pont _ es egy tilde _ kozott')
    expect(literalHeredocBody('x).')).toBe('x)_')
    expect(literalHeredocBody('. /etc/profile')).toBe('_ /etc/profile')
  })

  it('leaves a PATH-LIKE word alone, and keeps the glob rule unchanged', () => {
    expect(literalHeredocBody('~/x/y.json es ./x es ../y')).toBe('~/x/y.json es ./x es ../y')
    expect(literalHeredocBody('a/* b')).toBe('a/_ b')
    expect(literalHeredocBody('x),')).toBe('x),')
    expect(literalHeredocBody('x.')).toBe('x.')
  })

  it('a body that can run is returned unchanged (fail closed)', () => {
    expect(literalHeredocBody('valami (x). $(cat /etc/passwd)')).toBe('valami (x). $(cat /etc/passwd)')
    expect(literalHeredocBody('valami (x). `id`')).toBe('valami (x). `id`')
  })

  it('the segment OWN quoted span keeps the strict reading: literalQuotedGlobs is untouched', () => {
    expect(literalQuotedGlobs('rm -rf "."')).toBe('rm -rf "."')
    expect(literalQuotedGlobs("rm -rf '..'")).toBe("rm -rf '..'")
    expect(literalQuotedGlobs('cp a "~"')).toBe('cp a "~"')
    expect(literalQuotedGlobs('echo "a/*"')).toBe('echo "a/_"') // the #2514 glob rule still applies
  })
})

describe('2. a real bare . / .. / ~ in the command OWN words still denies', () => {
  it.each([
    'cd @H@/.claude && rm -rf .',
    'cd @H@/.claude && rm -rf "."',
    "cd @H@/.claude && rm -rf '.'",
    'cd @H@/.claude && tar -xf /tmp/a.tar -C .',
    // a body that goes to a SHELL is not literal, so a bare . inside it is still a path
    "cat <<'SH' | bash\ncd @H@/.claude && rm -rf .\nSH",
    "cat <<'SH' | bash -s\ncd @H@/.claude && rm -rf .\nSH",
  ])('denied: %s', (c) => { expect(run(c).deny).toBe(true) })
})

describe('3. a literal body that only ends a sentence is data, whatever the sink reads it as', () => {
  it.each([
    // the script run directly, and a plain data sink
    `cat <<'JSON' | @R@/scripts/dash-api.sh POST /api/daily-log\n${BODY}\nJSON`,
    `cat <<'JSON' | curl -s -d @- http://localhost:3420/api/daily-log\n${BODY}\nJSON`,
    `cat <<'JSON' | cat\n${BODY}\nJSON`,
    `cat <<'MSG' | bash @R@/scripts/agent-msg.sh sanyiba boss -\n${PROSE}\nMSG`,
    // writing the same prose to a file names no path either
    `cat > /tmp/naplo.txt <<'TXT'\n${PROSE}\nTXT`,
  ])('free: %s', (c) => { expect(run(c)).toEqual(FREE) })

  it('a body that NAMES a protected path still denies, sink or no sink', () => {
    expect(run(`cat <<'JSON' | @R@/scripts/dash-api.sh POST /api/daily-log\n{"content":"a @H@/.claude/settings.json nem irhato. Vege."}\nJSON`).deny).toBe(true)
    expect(run(`cat <<'JSON' | curl -s -d @- http://x/\n{"content":"a @H@/.claude/settings.json nem irhato. Vege."}\nJSON`).deny).toBe(true)
  })
})

describe('4. THE REMAINING GAP, pinned on purpose (see the header): `bash <script>` keeps the body non-literal', () => {
  it('the form CLAUDE.md prescribes still denies -- reShellsText reads the word `bash` as re-shelling', () => {
    expect(run(`cat <<'JSON' | bash @R@/scripts/dash-api.sh POST /api/daily-log\n${BODY}\nJSON`).deny).toBe(true)
    expect(run(`cat <<'JSON' | sh @R@/scripts/dash-api.sh POST /api/daily-log\n${BODY}\nJSON`).deny).toBe(true)
  })
})
