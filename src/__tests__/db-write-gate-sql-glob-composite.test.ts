// SQLGLOBARG1124 (2) -- the SAME rule in the SECOND implementation, and a test that asserts the COMPOSITE verdict.
//
// WHY THIS TEST EXISTS, and it is the lesson of the round that produced it: `sqlite3 -readonly <db> "SELECT COUNT(*)
// FROM t"` from the install root is read as a bare glob by TWO gates -- db-write-gate's classifyWord and
// self-pace-gate's protected-store check (PROTECTED_GLOB_TARGETS, whose `local-hooks` DIRECTORY target matches when
// the glob's parent is the install root). #6 narrowed the first one and was verified with that gate's own decision
// function, which cannot see the second: the composite verdict never changed, only the deny MESSAGE did
// (ENVRELAXGATE1104 -> "Egress-engedelylista"). lucky measured the still-denied call, sanyiba reproduced it and
// found this site.
//
// So every row below asserts the PAIR (which gate denies), not only the OR. A later narrowing that moves the deny
// from one gate to the other -- exactly what happened -- then fails loudly instead of looking like success.
//
// The predicate now lives in self-pace-gate.mjs and db-write-gate re-exports it: one mechanism, one definition.
// The decision functions only read paths: nothing here writes a real config.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/hooks/db-write-gate.mjs'
// @ts-expect-error -- plain .mjs module, no types
import { protectedContext, protectedStoreBashSegmentAllowed, allowlistBashSegmentAllowed, protectedSplit, sqliteReadonlyQuery, shellWords, commandName } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agent: string
let home: string
let savedHome: string | undefined
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sql-glob-composite-')))
  root = join(base, 'Install')
  agent = join(root, 'agents', 'sanyiba')
  home = join(base, 'home')
  for (const d of [join(agent, '.claude'), join(agent, '.claude-config'), join(root, 'store'),
    join(root, 'scripts', 'hooks'), join(root, 'local-hooks'), join(home, '.claude')]) {
    mkdirSync(d, { recursive: true })
  }
  for (const f of [[join(home, '.claude', 'settings.json'), '{}'], [join(agent, '.claude', 'settings.json'), '{}'],
    [join(root, '.env'), 'WEB_PORT=3420\n'], [join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}'],
    [join(root, 'store', 'extra-hooks.json'), '{}']] as [string, string][]) {
    writeFileSync(f[0], f[1])
  }
  savedHome = process.env.HOME
  process.env.HOME = home
})
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(base, { recursive: true, force: true })
})

// The composite a real Bash call gets: denied if ANY wired gate denies. Only these two can decide this shape; when a
// third one can, it belongs here, and that is the point of keeping the verdict a PAIR.
//
// The self-pace side is called the way production calls it: protectedSplit (the QUOTE-AWARE splitter -- the naive
// splitSegments cuts `SELECT COUNT(*)` on the `)` into two segments, which would measure a different command and is
// the very mistake this round is about), then protectedContext, then protectedStoreBashSegmentAllowed per segment.
// Production also sets rgConfigNamed / homeTouched / definite; for the single-segment rows below those are false or
// empty by construction, and the row asserts segs.length === 1 so the simplification cannot drift silently.
const composite = (raw: string, cwd: string) => {
  const command = raw.replaceAll('@R@', root)
  const db = gateDecision('Bash', { command }, { cwd, root, subAgent: true, projectDir: agent, configDir: join(agent, '.claude-config') }).deny === true
  const segs = protectedSplit(command).segs
  expect(segs.length).toBe(1)
  const ctx = protectedContext(segs, join(root, 'store', 'egress-allowlist.json'), cwd)
  // BOTH self-pace checks, as production runs them per segment (self-pace-gate.mjs, the protected-store line and the
  // egress-allowlist line). Running only the first one is how the first version of this test measured `selfPace:
  // false` for every row -- including `rm -rf *` from the root, which the live gate demonstrably denies: the live
  // deny carries reason 'egress-allowlist', i.e. it comes from the SECOND check. The pair assertion is what exposed
  // that, which is the same lesson one level down.
  const selfPace = segs.some((seg: string) => !protectedStoreBashSegmentAllowed(seg, ctx) || !allowlistBashSegmentAllowed(seg, ctx))
  return { deny: db || selfPace, db, selfPace }
}

const DB = 'store/claudeclaw.db'   // relative to the install root; @R@ = the temp root, substituted in composite()
const FREE = { deny: false, db: false, selfPace: false }

describe('1. the positive control: BOTH gates read the bare glob, in this fixture', () => {
  // Shares the failure mode: the same star, the same cwd, only -readonly missing. If this row ever goes free, the
  // fixture stopped producing the hit and every "free" row below would prove nothing.
  it('without -readonly, from the install root: BOTH gates deny', () => {
    expect(composite(`sqlite3 ${DB} "SELECT COUNT(*) FROM agent_messages;"`, root)).toEqual({ deny: true, db: true, selfPace: true })
  })
  it('and the star is the trigger: count(1) is free on both', () => {
    expect(composite(`sqlite3 -readonly ${DB} "SELECT count(1) FROM agent_messages;"`, root)).toEqual(FREE)
  })
})

describe('2. the prescribed read is free on the COMPOSITE, not just on one gate', () => {
  it.each([
    `sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM agent_messages;"`,
    `sqlite3 -readonly @R@/${DB} "SELECT COUNT(*) FROM agent_messages;"`,
    `sqlite3 -readonly ${DB} "SELECT * FROM agent_messages LIMIT 1;"`,
    `sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM agent_messages WHERE to_agent='sanyiba';"`,
    `sqlite3 -readonly ${DB} "SELECT id FROM agent_messages WHERE content GLOB '*kapu*';"`,
  ])('free, and neither gate denies: %s', (c) => { expect(composite(c, root)).toEqual(FREE) })
})

describe('3. what stays denied -- and BY WHICH GATE', () => {
  it.each([
    // michel's shape: no -readonly, so the db-write predicate refuses and BOTH gates deny
    [`sqlite3 ${DB} "SELECT COUNT(*) FROM agent_messages;"`, { deny: true, db: true, selfPace: true }],
    // a dot-command: ONLY the db-write gate denies it, and that asymmetry is measured, not assumed -- the command
    // carries no glob at all, so the self-pace glob check has nothing to see. Pinned so a later change that makes
    // the second gate speak here (or silences the first) is visible.
    [`sqlite3 -readonly ${DB} ".backup /tmp/x.db"`, { deny: true, db: true, selfPace: false }],
    // two sql arguments, and an expansion: outside the recognised shape
    [`sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM t;" "SELECT 1;"`, { deny: true, db: true, selfPace: true }],
    [`sqlite3 -readonly ${DB} "SELECT COUNT(*) FROM $T;"`, { deny: true, db: true, selfPace: true }],
    // a protected path written out INSIDE the sql: still a word both gates see
    [`sqlite3 -readonly ${DB} "ATTACH '${'@R@'}/store/extra-hooks.json' AS x;"`, { deny: true, db: true, selfPace: true }],
    // the bare-glob rule itself, on commands that really do act on paths
    ['rm -rf *', { deny: true, db: true, selfPace: true }],
    ['cp /tmp/x *', { deny: true, db: true, selfPace: true }],
  ] as [string, { deny: boolean, db: boolean, selfPace: boolean }][])('denied: %s', (c, want) => {
    expect(composite(c, root)).toEqual(want)
  })
})

describe('4. the limits of the narrowing stay where #6 put them', () => {
  const ABS = `sqlite3 -readonly @R@/${DB} "SELECT COUNT(*) FROM agent_messages;"`
  it('a protected directory as the cwd: still denied', () => {
    expect(composite(ABS, join(root, 'scripts', 'hooks')).deny).toBe(true)
  })
  it('outside the install tree: still denied', () => {
    expect(composite(ABS, home).deny).toBe(true)
  })
  it('from the agent own directory: free (it always was)', () => {
    expect(composite(ABS, agent)).toEqual(FREE)
  })
})

describe('5. the predicate is ONE definition, re-exported', () => {
  it.each([
    ['sqlite3 -readonly db "SELECT COUNT(*) FROM t"', true],
    ['sqlite3 db "SELECT COUNT(*) FROM t"', false],
    ['sqlite3 -readonly db ".schema"', false],
    ['sqlite3 -readonly db "SELECT 1" "SELECT 2"', false],
    ['sqlite3 -readonly $DB "SELECT 1"', false],
  ])('sqliteReadonlyQuery(%s) -> %s, from self-pace-gate', (cmd, want) => {
    const w = shellWords(cmd as string)
    expect(sqliteReadonlyQuery(w, commandName(w))).toBe(want)
  })
})
