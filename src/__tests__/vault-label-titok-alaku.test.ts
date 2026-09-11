import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const { mkdirSync } = require('node:fs') as typeof import('node:fs')
  const gyoker = mkdtempSync(join(tmpdir(), 'vaultlabel-test-'))
  mkdirSync(join(gyoker, 'store'), { recursive: true })
  return gyoker
})
vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot }))
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => false,
  keychainRetrieveStatus: () => ({ status: 'unavailable', value: null }),
  keychainRetrieve: () => null,
  keychainStore: () => {},
  keychainDelete: () => true,
}))

const { labelTitokAlaku, setSecret, listSecrets } = await import('../web/vault.js')

// THREE CASES, AND THE MIDDLE ONE IS THE POINT.
// A guard that only rejects the leaked value looks correct while being far too strict:
// a rule of "no space means secret" would refuse `DEEPSEEK_API_KEY`, which scripts/setup.ts
// passes today, and the next person would not be able to record a label at all. The two
// ends measure that the filter fires and that prose survives; the middle case is what pins
// the threshold, because that is where a filter actually goes wrong.
describe('labelTitokAlaku', () => {
  it('a real spaced description passes', () => {
    expect(labelTitokAlaku('Evedd hirlevel kapcsolati lista titok')).toBe(false)
    expect(labelTitokAlaku('SSH private key: jarvis-railway')).toBe(false)
  })

  it('a real spaceless identifier that is in use today passes', () => {
    // scripts/setup.ts:159 -- `setSecret('DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY', dsKey)`.
    // 17 characters, no space. A space-only rule would break the installer.
    expect(labelTitokAlaku('DEEPSEEK_API_KEY')).toBe(false)
    expect('DEEPSEEK_API_KEY'.length).toBeLessThan(32)
  })

  it('a secret-shaped value is refused', () => {
    const titokAlak = 'a'.repeat(64)
    expect(titokAlak.length).toBe(64)
    expect(labelTitokAlaku(titokAlak)).toBe(true)
  })

  it('the boundary is where the measurement put it, and both sides are asserted', () => {
    // Below the threshold nothing is refused, at it everything spaceless is -- stated
    // explicitly so a later edit to the constant cannot pass unnoticed.
    expect(labelTitokAlaku('x'.repeat(31))).toBe(false)
    expect(labelTitokAlaku('x'.repeat(32))).toBe(true)
    // A long label WITH spaces stays legitimate: the longest real one is 85 characters.
    expect(labelTitokAlaku('ez egy nagyon hosszu, de teljesen szabalyos magyar leiras a titokrol')).toBe(false)
  })
})

// THE DECISION IS NOT THE GUARD. A predicate that answers correctly and is never called
// is indistinguishable from no predicate at all, so these cases drive `setSecret` itself
// and then read the file back -- the wiring is measured separately from the verdict.
describe('setSecret refuses a secret-shaped label', () => {
  it('throws, and writes NOTHING to the vault', () => {
    const titok = 'b'.repeat(64)
    expect(() => setSecret('proba-elutasitott', titok, 'a valodi ertek')).toThrowError(
      /looks like a secret, not a description/,
    )
    // FAIL-CLOSED, NOT FAIL-LOUD-THEN-WRITE: the entry must not exist afterwards.
    expect(listSecrets().some((e) => e.id === 'proba-elutasitott')).toBe(false)
  })

  it('the error names the rule, the id and the SHAPE -- and never the value', () => {
    const titok = 'c'.repeat(64)
    let uzenet = ''
    try { setSecret('proba-uzenet', titok, 'SZIGORUAN-TITKOS-ERTEK-42') } catch (e) { uzenet = (e as Error).message }
    expect(uzenet).toContain('proba-uzenet')      // which call site
    expect(uzenet).toContain('64 characters')      // the measured shape
    expect(uzenet).toContain('(id, label, value)') // the rule
    // AND THE POINT OF THE WHOLE CHANGE: a guard that keeps a secret out of a cleartext
    // file must not read it out through the error channel instead.
    expect(uzenet).not.toContain('SZIGORUAN-TITKOS-ERTEK-42')
    expect(uzenet).not.toContain(titok)
  })

  it('a legitimate description still gets written', () => {
    // POSITIVE CONTROL for the two cases above: without it, a `setSecret` that threw on
    // EVERYTHING would satisfy them both.
    setSecret('proba-rendben', 'Evedd kapcsolati lista titok', 'ertek-42')
    expect(listSecrets().some((e) => e.id === 'proba-rendben')).toBe(true)
    expect(existsSync(join(tmpRoot, 'store', 'vault.json'))).toBe(true)
    // and the stored label is the description, not the value
    const nyers = readFileSync(join(tmpRoot, 'store', 'vault.json'), 'utf-8')
    expect(nyers).toContain('Evedd kapcsolati lista titok')
    expect(nyers).not.toContain('ertek-42')
  })
})
