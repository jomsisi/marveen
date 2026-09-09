import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ertekeldRestartEredmenyt, type RestartEredmeny } from '../context-guard.js'
import { readNewestTranscriptNameFromProjectDir } from '../web/active-model.js'

/**
 * A GUARD A SAJAT BEAVATKOZASANAK AZ EREDMENYET MERI, NEM A TENYET.
 *
 * A LELET (safar, 2026-09-07): ket restart ugyanazon a napon, ugyanazon az agensen,
 * ugyanazon a kod-uton, ugyanazzal a ket naplosorral (tmux stopped / started) -- es
 * KULONBOZO kimenettel. A 19:42-es uj transzkriptet nyitott; a 12:38-as NEM, es a regi
 * session futott tovabb HET ORAT 100%-os kontextussal. Abban az allapotban kapta meg a
 * 19:00-as hirlevel-munkat. A naplo mindket esetnel "sikeres restart"-ot mutatott.
 *
 * A KONTROLL-PAR EZ A KET ESET, es a teszt mindkettot elojatssza a fajlrendszeren.
 * Egy olyan teszt, ami CSAK a negativ esetet allitja ("hatastalan restartra szolunk"),
 * akkor is zold, ha a fuggveny MINDIG hatastalant mond -- vagyis minden helyes
 * restart utan is riasztana. A ket irany egyutt allitas, kulon-kulon egyik sem.
 */
describe('a restart EREDMENYE -- a transzkript identitasa dont, nem az mtime', () => {
  const ALAP = { eltelteMs: 10 * 60_000, turelmiMs: 6 * 60_000 }

  it('POZITIV ESET (19:42): UJ transzkript keletkezett -> uj-session', () => {
    expect(ertekeldRestartEredmenyt({ ...ALAP, elozoTranszkript: '2bf78406.jsonl', mostaniTranszkript: 'a72d96c4.jsonl' }))
      .toBe<RestartEredmeny>('uj-session')
  })

  it('NEGATIV ESET (12:38): UGYANAZ a transzkript fut tovabb -> hatastalan', () => {
    expect(ertekeldRestartEredmenyt({ ...ALAP, elozoTranszkript: '2bf78406.jsonl', mostaniTranszkript: '2bf78406.jsonl' }))
      .toBe<RestartEredmeny>('hatastalan')
  })

  it('A TURELMI IDON BELUL MEG NEM DONTUNK -- kulonben MINDEN restart hatastalannak latszana', () => {
    // Egy friss session az ELSO forduloja utan ir eloszor. Egy azonnali ellenorzes a mi
    // sietsegunket merne, nem a restartot.
    expect(ertekeldRestartEredmenyt({ elozoTranszkript: 'x.jsonl', mostaniTranszkript: 'x.jsonl', eltelteMs: 60_000, turelmiMs: 6 * 60_000 }))
      .toBe<RestartEredmeny>('varunk')
  })

  it('OLVASHATATLAN MAPPA -> nem-merheto, es NEM hatastalan', () => {
    // A ket kimenet osszevonasa ketfele karral jarna: "hatastalan"-kent egy jogosultsag-
    // hiba VALODI riasztast szulne, "uj-session"-kent egy nema hiba latszana rendnek.
    expect(ertekeldRestartEredmenyt({ ...ALAP, elozoTranszkript: 'x.jsonl', mostaniTranszkript: null }))
      .toBe<RestartEredmeny>('nem-merheto')
  })

  it('NEM VOLT ELOZO, MOST VAN -> uj-session (elso indulas)', () => {
    expect(ertekeldRestartEredmenyt({ ...ALAP, elozoTranszkript: null, mostaniTranszkript: 'uj.jsonl' }))
      .toBe<RestartEredmeny>('uj-session')
  })
})

describe('a jel maga: a transzkript NEVE valtozik, az MTIME-ja nem elegendo', () => {
  /** Egy projekt-mappa a fajlrendszeren, `<mappa>/projects/<kodolt-ut>` alakban. */
  function projektMappa(): { root: string; dir: string; workingDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'guard-restart-'))
    const workingDir = '/root/pelda-agens'
    const dir = join(root, 'projects', workingDir.replace(/[/.]/g, '-'))
    mkdirSync(dir, { recursive: true })
    return { root, dir, workingDir }
  }

  it('A HATASTALAN RESTART UTAN AZ MTIME FRISSUL, A NEV NEM -- ez a ketto kulonbsege', () => {
    // EZ A TESZT LENYEGE. A tovabbfuto REGI session ir a sajat fajljaba, tehat az
    // mtime-alapu jel "tortent valami"-t mondana -- pontosan a rossz valaszt.
    const { root, dir, workingDir } = projektMappa()
    try {
      const regi = join(dir, '2bf78406.jsonl')
      writeFileSync(regi, '{}\n')
      const elotte = readNewestTranscriptNameFromProjectDir(workingDir, root)
      expect(elotte).toBe('2bf78406.jsonl')

      // a "restart" utan a REGI session tovabb ir: az mtime elorelep
      const kesobb = new Date(Date.now() + 60_000)
      writeFileSync(regi, '{}\n{}\n')
      utimesSync(regi, kesobb, kesobb)

      const utana = readNewestTranscriptNameFromProjectDir(workingDir, root)
      expect(utana, 'a NEV valtozatlan, barmennyit irt a regi session').toBe(elotte)
      expect(ertekeldRestartEredmenyt({ elozoTranszkript: elotte, mostaniTranszkript: utana, eltelteMs: 10 * 60_000, turelmiMs: 6 * 60_000 }))
        .toBe<RestartEredmeny>('hatastalan')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('POZITIV KONTROLL: UJ fajl -> a nev valtozik, es a dontes uj-session', () => {
    // Enelkul a fenti allitas egy olyan helperrel is zold lenne, ami MINDIG ugyanazt
    // a nevet adja vissza -- vagyis sosem venne eszre egy valodi uj sessiont.
    const { root, dir, workingDir } = projektMappa()
    try {
      const regi = join(dir, '2bf78406.jsonl')
      writeFileSync(regi, '{}\n')
      const elotte = readNewestTranscriptNameFromProjectDir(workingDir, root)

      const uj = join(dir, 'a72d96c4.jsonl')
      writeFileSync(uj, '{}\n')
      const kesobb = new Date(Date.now() + 60_000)
      utimesSync(uj, kesobb, kesobb)

      const utana = readNewestTranscriptNameFromProjectDir(workingDir, root)
      expect(utana).toBe('a72d96c4.jsonl')
      expect(utana).not.toBe(elotte)
      expect(ertekeldRestartEredmenyt({ elozoTranszkript: elotte, mostaniTranszkript: utana, eltelteMs: 10 * 60_000, turelmiMs: 6 * 60_000 }))
        .toBe<RestartEredmeny>('uj-session')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('URES MAPPA -> null, tehat "nem merheto", nem "hatastalan"', () => {
    const { root, workingDir } = projektMappa()
    try {
      expect(readNewestTranscriptNameFromProjectDir(workingDir, root)).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
