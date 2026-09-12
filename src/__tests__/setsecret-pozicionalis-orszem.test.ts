import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * WHY THE WALK AND NOT THE COMPILER.
 *
 * `setSecret` now takes one named object, so every call under src/ is checked by tsc.
 * scripts/setup.ts is NOT: it reaches the vault through a runtime
 * `await import('../dist/web/vault.js')`, the build output, so no tsconfig can measure
 * that call against this source. Measured 2026-09-12: changing the signature produced 18
 * errors, one per call site under src/, and restoring the old positional form in that
 * script afterwards still left the typecheck at zero.
 *
 * Widening a tsconfig would close that one hole and leave the class open -- the next
 * script, or the next dynamic import, arrives outside it again. So the rule is stated
 * where it holds for the whole tree: the file list comes from `git ls-files`, so anything
 * added to the repo is in scope the day it lands, without anyone remembering to add it.
 *
 * What a positional call costs, if one comes back: tsc stays quiet for that file, and at
 * run time the destructuring takes a string apart into nothing -- id, label and value all
 * undefined, written as such. No throw, no error. That is the failure this pins.
 */

/**
 * A call is legal only in the named-object form: `setSecret({`.
 *
 * Two shapes have to be let through, and BOTH were found by running this, not by
 * imagining them:
 *  - a COMMENT describing the old signature -- vault.ts does that deliberately, so the
 *    next reader learns what the guard was for;
 *  - a mention inside a STRING -- the guard's own throw message reads
 *    `setSecret(<id>): ...` on purpose, because that is how the caller will recognise
 *    which call it came from.
 * Neither is a call, and a scanner that cannot tell them apart is one that gets silenced.
 * Being inside a string is decided by counting quote characters to the left of the match:
 * an odd count means the text is quoted.
 */
function pozicionalisHivasok(szoveg: string): string[] {
  const talalatok: string[] = []
  szoveg.split('\n').forEach((nyers, i) => {
    const sor = nyers.trim()
    if (sor.startsWith('//') || sor.startsWith('*')) return
    if (/export\s+function\s+setSecret/.test(sor)) return
    const m = /\bsetSecret\s*\(/.exec(sor)
    if (!m) return
    if (/\bsetSecret\s*\(\s*\{/.test(sor)) return
    const elotte = sor.slice(0, m.index)
    for (const jel of ['`', "'", '"']) {
      if ((elotte.split(jel).length - 1) % 2 === 1) return
    }
    talalatok.push(`${i + 1}: ${sor}`)
  })
  return talalatok
}

const FAJLOK = execFileSync('git', ['ls-files', '*.ts', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'], {
  cwd: REPO,
  encoding: 'utf-8',
})
  .split('\n')
  .filter(Boolean)

describe('setSecret: no positional call anywhere in the tree', () => {
  it('the walk actually has a tree to walk', () => {
    // Without this the whole file passes on an empty list -- green while measuring nothing.
    expect(FAJLOK.length).toBeGreaterThan(200)
    expect(FAJLOK).toContain('src/web/vault.ts')
    // The file the compiler cannot reach is the reason this test exists, so its presence
    // in the list is itself an assertion.
    expect(FAJLOK).toContain('scripts/setup.ts')
  })

  it('the detector recognises a positional call and accepts the named one', () => {
    // POSITIVE CONTROL on the RULE, so a green run below cannot come from a filter that
    // matches nothing. Both samples are synthetic; neither is read from the tree.
    expect(pozicionalisHivasok("    setSecret('a', 'b', c)")).toHaveLength(1)
    expect(pozicionalisHivasok('    setSecret(vaultId, `x`, value)')).toHaveLength(1)
    expect(pozicionalisHivasok("    setSecret({ id: 'a', label: 'b', value: c })")).toHaveLength(0)
    expect(pozicionalisHivasok("    // setSecret('a', 'b', c) -- describing the old form")).toHaveLength(0)
    // The throw message in vault.ts has exactly this shape, and it is not a call.
    expect(pozicionalisHivasok('      `setSecret(${JSON.stringify(id)}): the label looks wrong ` +')).toHaveLength(0)
  })

  it('no tracked file contains one', () => {
    const talalatok: string[] = []
    for (const f of FAJLOK) {
      let szoveg: string
      try { szoveg = readFileSync(join(REPO, f), 'utf-8') } catch { continue }
      if (!szoveg.includes('setSecret')) continue
      for (const t of pozicionalisHivasok(szoveg)) talalatok.push(`${f}:${t}`)
    }
    expect(talalatok).toEqual([])
  })
})
