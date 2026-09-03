import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { mainAgentModeIsFresh } from '../web/auto-restart-store.js'
import { DEFAULT_AUTO_RESTART } from '../auto-restart.js'

// The main channels session always respawns fresh, so the runner never reads
// cfg.mode for it. The stored 'continue' was therefore a field nothing could
// honour -- and the harm was not cosmetic: someone who flips it, sees no change
// and concludes "so that is not the cause" gets a FALSE DISPROOF. The write path
// now stores what actually happens.

const HERE = dirname(fileURLToPath(import.meta.url))
function code(rel: string): string {
  // Strip comments before searching. Every comment in these files DISCUSSES the
  // very identifiers asserted on below, so an unstripped search would match the
  // prose and prove nothing.
  return readFileSync(join(HERE, rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}
const STORE = code('../web/auto-restart-store.ts')
const RUNNER = code('../web/auto-restart-runner.ts')

describe('mainAgentModeIsFresh', () => {
  const cont = { ...DEFAULT_AUTO_RESTART, mode: 'continue' as const }

  it('forces the main agent row to fresh', () => {
    expect(mainAgentModeIsFresh(MAIN_AGENT_ID, cont).mode).toBe('fresh')
  })

  it('leaves every other agent alone', () => {
    expect(mainAgentModeIsFresh('sanyiba', cont).mode).toBe('continue')
    expect(mainAgentModeIsFresh('michel', cont).mode).toBe('continue')
  })

  it('changes nothing else on the config', () => {
    const src = { ...DEFAULT_AUTO_RESTART, mode: 'continue' as const, dailyTime: '03:00', handoff: true }
    const out = mainAgentModeIsFresh(MAIN_AGENT_ID, src)
    expect({ ...out, mode: 'continue' }).toEqual(src)
  })

  it('does not copy the object when there is nothing to change', () => {
    const fresh = { ...DEFAULT_AUTO_RESTART, mode: 'fresh' as const }
    expect(mainAgentModeIsFresh(MAIN_AGENT_ID, fresh)).toBe(fresh)
  })
})

// THE LOAD-BEARING PAIR. Normalizing on the READ path would be tempting -- the
// dashboard would then never show a stale 'continue' at all -- but it would make
// the runner's warning condition (stored mode !== 'fresh') permanently false and
// SILENTLY DELETE the sentinel. The two changes were approved separately and,
// put in the wrong place, cancel each other. That is what these tests pin.
describe('write-side only (the sentinel depends on it)', () => {
  it('positive control: the comment stripper left the functions intact', () => {
    expect(STORE).toContain('export function writeAutoRestartConfig')
    expect(STORE).toContain('export function readAutoRestartConfig')
    expect(RUNNER).toContain('function warnIfMainModeIgnored')
  })

  it('the write path normalizes the main agent row', () => {
    const body = STORE.split('export function writeAutoRestartConfig')[1] ?? ''
    expect(body.length, 'writeAutoRestartConfig body not found').toBeGreaterThan(40)
    expect(body.split('\n}')[0]).toContain('mainAgentModeIsFresh')
  })

  it('the read path does NOT normalize -- that would kill the runner warning', () => {
    const body = (STORE.split('export function readAutoRestartConfig')[1] ?? '').split('\n}')[0]
    expect(body.length, 'readAutoRestartConfig body not found').toBeGreaterThan(40)
    expect(body).not.toContain('mainAgentModeIsFresh')
  })

  it('the runner warns before the enabled-guard, not only when a restart is due', () => {
    const check = RUNNER.split('function checkAgent')[1] ?? ''
    expect(check.length, 'checkAgent body not found').toBeGreaterThan(40)
    const warnAt = check.indexOf('warnIfMainModeIgnored')
    const guardAt = check.indexOf('if (!cfg.enabled)')
    expect(warnAt, 'checkAgent does not call warnIfMainModeIgnored').toBeGreaterThan(-1)
    expect(guardAt, 'the enabled-guard moved or was renamed').toBeGreaterThan(-1)
    expect(warnAt).toBeLessThan(guardAt)
  })
})
