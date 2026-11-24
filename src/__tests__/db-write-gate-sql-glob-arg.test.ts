// SQLGLOBARG1124 (sanyiba 13467, boss 13468): `sqlite3 -readonly <db> "SELECT COUNT(*) ..."` -- a read the gate's own
// deny text calls allowed ("Olvasni szabad (SELECT, sqlite3 -readonly)") -- was DENIED for every sub-agent when the
// cwd was the install root, which is the cwd CLAUDE.md's own recipe implies (its db path is relative).
//
// THE MEASURED CAUSE: the `*` of `COUNT(*)` is a word of its own (the reader splits on `()`), and `literalWords`
// deliberately leaves a glob-ONLY token alone inside a quoted span -- a re-shelled `"*"` really is expanded. The
// compensating skip (bareGlobQuoted, #2514) only applies in the CALLER'S OWN project dir, so from the install root
// the quoted `*` was matched against the protected entries (store/, scripts/) and gave an exact/under hit.
//
// Measured matrix, 2026-11-24, same command, only the cwd and the caller changing:
//   sub-agent, cwd = install root ... DENY      | main agent (project dir IS the root) ... free
//   sub-agent, cwd = own dir ....... free       | sub-agent, cwd = a third dir ......... free
//   `count(id)` instead of COUNT(*)  free       | `SELECT *` ........................... DENY
// So neither the command nor the cwd decides alone, and the main agent never saw it.
//
// THE FIX RECOGNISES EXACTLY THAT SHAPE AND NOTHING WIDER (boss 13468): `-readonly`, no other option, exactly two
// operands (the db and ONE sql argument), no dot-command, no expansion. It removes only the GLOB reading: a path
// written out inside the SQL is still a word the gate sees, so the db-file and protected-path rules are untouched.
// The decision function only reads paths: nothing here writes a real config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, sqliteReadonlyQuery } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs module, no types
import { shellWords, commandName } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
let home: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sql-glob-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'sanyiba')
  home = join(base, 'home')
  for (const d of [join(agent, '.claude'), join(agent, '.claude-config'), join(root, 'store'),
    join(root, 'scripts', 'hooks'), join(home, '.claude')]) {
    mkdirSync(d, { recursive: true })
  }
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  writeFileSync(join(agent, '.claude', 'settings.json'), '{}')
  writeFileSync(join(root, '.env'), 'WEB_PORT=3420\n')
  writeFileSync(join(root, 'store', 'provenance-gate-rules.json'), '{}')
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

const FREE = { deny: false }
// the sub-agent's case: cwd = the install ROOT, project dir = its own directory
const run = (command: string, cwd?: string) => gateDecision('Bash', { command: command.replaceAll('@R@', root) },
  { cwd: cwd ?? root, root, subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') })

const DB = 'store/claudeclaw.db'

describe('1. the positive control: the trigger is LIVE in this fixture', () => {
  // Shares the failure mode: the SAME sql, the SAME cwd, the same db -- only the thing the fix keys on differs.
  // Without these rows the "free" table below would pass even if the fixture never produced the glob hit.
  it('the same query WITHOUT -readonly: denied', () => {
    expect(run(`sqlite3 ${DB} "SELECT COUNT(*) FROM agent_messages;"`).deny).toBe(true)
  })
  it('and the `*` is the trigger: count(id) passes even without -readonly', () => {
    expect(run(`sqlite3 ${DB} "SELECT count(id) FROM agent_messages;"`)).toEqual(FREE)
  })
  it('and it needs a cwd that is not the caller own project dir: from its own dir it passes', () => {
    expect(run(`sqlite3 @R@/${DB} "SELECT COUNT(*) FROM agent_messages;"`, agent)).toEqual(FREE)
  })
})

describe('2. the read CLAUDE.md prescribes is free', () => {
  it.each([
    `sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM agent_messages;"`,
    `sqlite3 -readonly @R@/${DB} "SELECT COUNT(*) FROM agent_messages;"`,
    `cd @R@ && sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM agent_messages WHERE to_agent='sanyiba';"`,
    `sqlite3 -readonly ${DB} "SELECT * FROM agent_messages WHERE id=13457;"`,
    // several statements in ONE argument, which is how a measurement with its own control is written
    `sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM agent_messages; SELECT COUNT(*) FROM daily_logs;"`,
    // a SQL wildcard that is not the column star
    `sqlite3 -readonly ${DB} "SELECT id FROM agent_messages WHERE content LIKE '%*%';"`,
    `sqlite3 -readonly ${DB} "SELECT id FROM agent_messages WHERE content GLOB '*kapu*';"`,
    // the other spelling of the binary, and single quotes around the sql
    `sqlite3 -readonly ${DB} 'SELECT COUNT(*) FROM agent_messages;'`,
    `sqlite -readonly ${DB} "SELECT COUNT(*) FROM agent_messages;"`,
    // piped onward: the sql argument is still just sql
    `sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM agent_messages;" | grep -c .`,
  ])('free: %s', (c) => { expect(run(c)).toEqual(FREE) })
})

describe('3. what the exception must NOT open', () => {
  it.each([
    // no -readonly: not the shape the owner approved
    `sqlite3 ${DB} "SELECT COUNT(*) FROM agent_messages;"`,
    // any other option: outside the measured shape, so the deny stays
    `sqlite3 -readonly -header ${DB} "SELECT COUNT(*) FROM agent_messages;"`,
    `sqlite3 -readonly -cmd ".read @R@/scripts/hooks/x.sql" ${DB} "SELECT COUNT(*) FROM t;"`,
    // more than one sql argument
    `sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM t;" "SELECT COUNT(*) FROM u;"`,
    // a dot-command can read or write files, whatever -readonly says about the main db
    `sqlite3 -readonly ${DB} ".read @R@/scripts/hooks/db-write-gate.mjs"`,
    `sqlite3 -readonly ${DB} ".backup '@R@/store/provenance-gate-rules.json'"`,
    `sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM t;
.restore @R@/store/claudeclaw.db"`,
    // a dot-command the word list does NOT name, on its own line: only the line-start rule refuses it, and the
    // same argument carries the bare glob, or the verdict would be free whatever the predicate decided. Added
    // because the mutation run found the line-start rule unpinned (every other dot row hit the word list too).
    `sqlite3 -readonly ${DB} ".schema
SELECT COUNT(*) FROM agent_messages;"`,
    `sqlite3 -readonly ${DB} "  .tables
SELECT COUNT(*) FROM agent_messages;"`,
    // an expansion: the gate cannot tell what runs or what is read
    `sqlite3 -readonly $DBPATH "SELECT COUNT(*) FROM agent_messages;"`,
    `sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM $TABLE;"`,
    // re-shelled: there the quoted `*` IS expanded by a shell
    `bash -c 'sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM t;"'`,
    // a protected path written out inside the sql is still a word the gate sees
    `sqlite3 -readonly ${DB} "ATTACH '@R@/store/provenance-gate-rules.json' AS x; SELECT COUNT(*) FROM x.t;"`,
    // the db-file and security-table rules are untouched
    `sqlite3 ${DB} "UPDATE approvals SET status='approved' WHERE id=1;"`,
    `sqlite3 -readonly ${DB} "UPDATE approvals SET status='approved' WHERE id=1;"`,
    // the bare-glob rule itself stays: a quoted `*` given to a program that acts on paths
    'rm -rf "*"',
    'tar -xf /tmp/x.tar "*"',
  ])('denied: %s', (c) => { expect(run(c).deny).toBe(true) })
})

describe('4. the two limits of the narrowing, pinned', () => {
  // (1) the cwd IS a protected directory (scripts/hooks is one): there every non-reading command is denied, and that
  // deny must not come to rest on a glob.
  it('a protected directory as the cwd: still denied', () => {
    expect(run(`sqlite3 -readonly @R@/${DB} "SELECT COUNT(*) FROM agent_messages;"`, join(root, 'scripts', 'hooks')).deny).toBe(true)
  })
  // ...and the reason no row can REACH the limit above: from inside a protected directory even a glob-free read is
  // denied, because every relative word (SELECT, FROM, t) is a candidate there. So the deny never comes to rest on
  // the glob, and a mutation that deletes the exact/under check survives. The check stays anyway: leaning on another
  // rule's side effect is how a rule turns into accidental structural protection.
  it('from inside a protected directory even a GLOB-FREE read is denied', () => {
    expect(run(`sqlite3 -readonly @R@/${DB} "SELECT count(id) FROM agent_messages;"`, join(root, 'scripts', 'hooks')).deny).toBe(true)
  })
  // (2) outside the INSTALL tree (a home tree, another worker's home): a sub-agent has no business reading there, and
  // the existing worker-config assertion encodes that broader intent. An earlier version of this fix turned that
  // assertion green, which is exactly the regression it exists to catch; the fix was narrowed instead of flipping it.
  it('a cwd outside the install tree: still denied', () => {
    expect(run(`sqlite3 -readonly @R@/${DB} "SELECT COUNT(*) FROM agent_messages;"`, home).deny).toBe(true)
  })
  // ...while the install root and a directory under it stay free, which is the measured case
  it('the install root and a directory under it: free', () => {
    expect(run(`sqlite3 -readonly @R@/${DB} "SELECT COUNT(*) FROM agent_messages;"`, root)).toEqual(FREE)
    expect(run(`sqlite3 -readonly claudeclaw.db "SELECT COUNT(*) FROM agent_messages;"`, join(root, 'store'))).toEqual(FREE)
  })
})

describe('5. sqliteReadonlyQuery reads the option, the operand count and the dot-commands', () => {
  it.each([
    ['sqlite3 -readonly db.sqlite "SELECT COUNT(*) FROM t"', true],
    ['sqlite3 -readonly /abs/store/claudeclaw.db "SELECT * FROM t"', true],
    ['sqlite -readonly db "SELECT 1"', true],
    ['sqlite3 db "SELECT COUNT(*) FROM t"', false],
    ['sqlite3 -readonly db "SELECT 1" "SELECT 2"', false],
    ['sqlite3 -readonly db', false],
    ['sqlite3 -readonly -header db "SELECT 1"', false],
    ['sqlite3 -readonly db ".read x.sql"', false],
    ['sqlite3 -readonly db ".backup y.db"', false],
    ['sqlite3 -readonly db "SELECT 1; .output /tmp/x"', false],
    // a dot-command outside the word list: the line-start rule is the only thing that sees it
    ['sqlite3 -readonly db ".schema"', false],
    ['sqlite3 -readonly db "  .tables"', false],
    ['sqlite3 -readonly $DB "SELECT 1"', false],
    ['sqlite3 -readonly db "SELECT * FROM $T"', false],
    ['psql -readonly db "SELECT COUNT(*) FROM t"', false],
    ['cat db "SELECT COUNT(*) FROM t"', false],
  ])('sqliteReadonlyQuery(%s) -> %s', (cmd, want) => {
    const w = shellWords(cmd as string)
    expect(sqliteReadonlyQuery(w, commandName(w))).toBe(want)
  })
})
