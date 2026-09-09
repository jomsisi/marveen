import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * A BEKOTES MERESE -- nem a dontese.
 *
 * A `context-guard-restart-eredmeny.test.ts` a TISZTA DONTEST meri, es negy mutaciot fog rajta.
 * Egyik sem szolal meg, ha a dontest SENKI NEM HIVJA. A boss 2026-09-09-en harom huzalozasi
 * mutaciot futtatott, es MIND A HAROM TULELT 4481 zold teszt mellett:
 *   - a kiertekelo hivasanak torlese a sweep elejerol,
 *   - a `if (!res.ok) throw` torlese (vagyis maga a javitas),
 *   - a fuggo bejegyzes (`.set`) torlese a restart utan.
 *
 * A repo ezt mar leirta: `main-config-guard-wiring.test.ts` -- "A guard that decides correctly
 * and is never called is indistinguishable, from the outside, from no guard at all", es a
 * 2026-09-04-i router-eset: negy piros a predikatumon, egy zold a HIVASON. Ma ugyanaz az alak.
 * Ezen a kartyan pedig kulonosen nem engedheto el: a targya EPP az, hogy egy beavatkozas
 * TENYE nem az EREDMENYE -- ha a mero bekotese meretlen, a mero maga tud nemaan hatastalanna
 * valni, egy szinttel feljebb.
 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'guard-huzalozas-'))
const AGENTS = join(SANDBOX, 'agents')
const CFG_DIR = join(SANDBOX, 'claude-config')
/**
 * MINDEN ESETNEK SAJAT AGENS-NEVE VAN, es ez nem kozmetika: a guard allapot-terkepe
 * MODUL-SZINTU es a sweepek kozott el (szandekosan -- a debounce ezen all). Kozos nev
 * mellett a masodik eset mar egy `await-ready` allapotot orokolne az elsotol, es a
 * telitettseg-halo fel sem allna -- a teszt nem azt merne, amit hisz rola.
 */
let AGENS = 'probaagens-0'
const munkakonyvtar = () => join(AGENTS, AGENS)
const projektDir = () => join(CFG_DIR, 'projects', munkakonyvtar().replace(/[/.]/g, '-'))

/** A telitett pane: a lablecben all a jel, ezt keresi a `paneShowsContextSaturation`. */
const TELITETT_PANE = ['valami', 'valami mas', '100% context used'].join('\n')

const restartAgentProcess = vi.fn(async () => ({ ok: true as boolean, error: undefined as string | undefined }))
const createAgentMessage = vi.fn()

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../db.js', () => ({ createAgentMessage }))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentRunState: () => 'running',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess,
  capturePane: () => TELITETT_PANE,
  sendPromptToSession: vi.fn(),
  isSessionReadyForPrompt: async () => false,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    listAllAgentNames: () => [AGENS],
    listAgentNames: () => [AGENS],
    readAgentClaudeConfigDir: () => CFG_DIR,
    readAgentRemoteHost: () => null,
  }
})

const { guardSweepOnce, getHardGuardPhase, RESTART_EREDMENY_TURELMI_MS } = await import('../web/context-guard-runner.js')

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

/** Egy transzkript-fajl a proba-agens projekt-mappajaban, megadott mtime-mal. */
function transzkript(nev: string, mtimeMs: number): void {
  mkdirSync(projektDir(), { recursive: true })
  const ut = join(projektDir(), nev)
  writeFileSync(ut, '{}\n')
  utimesSync(ut, new Date(mtimeMs), new Date(mtimeMs))
}

let sorszam = 0
beforeEach(() => {
  AGENS = `probaagens-${++sorszam}`
  restartAgentProcess.mockClear()
  createAgentMessage.mockClear()
  restartAgentProcess.mockImplementation(async () => ({ ok: true, error: undefined }))
  mkdirSync(munkakonyvtar(), { recursive: true })
  mkdirSync(join(SANDBOX, 'store'), { recursive: true })
})

/** A telitett pane ket egybehangzo sweep utan valt ki restartot (debounce). */
async function restartotKivalt(t0: number): Promise<void> {
  await guardSweepOnce(t0)
  await guardSweepOnce(t0 + 1000)
}

describe('a restart-eredmeny merese BE VAN KOTVE a sweepbe', () => {
  it('HATASTALAN RESTART -> a kesobbi sweep SZOL (ez fogja meg a kiertekelo es a fuggo-bejegyzes torleset)', async () => {
    const t0 = Date.now()
    transzkript('regi.jsonl', t0 - 60_000)
    await restartotKivalt(t0)
    expect(restartAgentProcess, 'a restart egyaltalan lefutott-e').toHaveBeenCalled()

    // A regi session TOVABB IR: az mtime elorelep, a NEV valtozatlan -- ez a hatastalan eset.
    transzkript('regi.jsonl', t0 + 60_000)
    createAgentMessage.mockClear()
    await guardSweepOnce(t0 + RESTART_EREDMENY_TURELMI_MS + 60_000)

    const uzenetek = createAgentMessage.mock.calls.map((c) => String(c[2] ?? ''))
    expect(uzenetek.some((u) => u.includes('HATASTALAN')), `a kikuldott uzenetek: ${JSON.stringify(uzenetek)}`).toBe(true)
  })

  it('POZITIV KONTROLL: UJ transzkript utan NEM szol', async () => {
    // Enelkul a fenti allitas egy olyan kodban is zold lenne, ami MINDEN restart utan riaszt --
    // vagyis a jelzes elertektelenedne, es a kovetkezo valodi esetet is atlapoznank.
    const t0 = Date.now() + 10 * 60_000
    transzkript('regi.jsonl', t0 - 60_000)
    await restartotKivalt(t0)
    transzkript('uj.jsonl', t0 + 60_000)
    createAgentMessage.mockClear()
    await guardSweepOnce(t0 + RESTART_EREDMENY_TURELMI_MS + 60_000)

    const uzenetek = createAgentMessage.mock.calls.map((c) => String(c[2] ?? ''))
    expect(uzenetek.some((u) => u.includes('HATASTALAN'))).toBe(false)
  })

  it('A FUGGO ELLENORZES LEMEZRE KERUL -- egy dashboard-restart nem nyeli el nyomtalanul', async () => {
    // Az elso valtozat memoriabeli terkepet hasznalt, es a boss vette eszre: egy
    // dashboard-ujrainditas (aznap reggel tortent egy) a bejegyzest nyomtalanul elvitte
    // volna -- vagyis a hatastalansag SOHA nem derul ki. Ugyanaz a hibaosztaly, ami ellen
    // ez az egesz kartya szol, egy szinttel feljebb.
    const t0 = Date.now() + 40 * 60_000
    transzkript('regi.jsonl', t0 - 60_000)
    await restartotKivalt(t0)
    const ut = join(SANDBOX, 'store', 'context-guard-restart-pending.json')
    expect(existsSync(ut), 'a fuggo ellenorzes fajlja').toBe(true)
    const m = JSON.parse(readFileSync(ut, 'utf-8'))
    expect(Object.keys(m)).toContain(AGENS)
    expect(m[AGENS].elozoTranszkript).toBe('regi.jsonl')
  })

  it('A TURELMI IDON BELUL MEG NEM SZOL -- a mero nem a sajat sietseget meri', async () => {
    const t0 = Date.now() + 20 * 60_000
    transzkript('regi.jsonl', t0 - 60_000)
    await restartotKivalt(t0)
    createAgentMessage.mockClear()
    await guardSweepOnce(t0 + 60_000)
    const uzenetek = createAgentMessage.mock.calls.map((c) => String(c[2] ?? ''))
    expect(uzenetek.some((u) => u.includes('HATASTALAN'))).toBe(false)
  })
})

describe('a sikertelen restart NEM viszi elore az allapotot', () => {
  it('`ok:false` -> az allapot NEM `await-ready` (ez fogja meg a dobas torleset)', async () => {
    // A `restartAgentProcess` NEM DOB egy sikertelen leallitasnal. Ha a hivo eldobja az
    // erteket, az allapot a 444. soron mar `await-ready`-re allt -- es a kovetkezo sweep egy
    // "folytasd a handoffbol" promptot injektalna UGYANABBA a telitett pane-be.
    const t0 = Date.now() + 30 * 60_000
    transzkript('regi.jsonl', t0 - 60_000)
    restartAgentProcess.mockImplementation(async () => ({ ok: false, error: 'szandekos teszt-hiba' }))
    await restartotKivalt(t0)

    expect(restartAgentProcess).toHaveBeenCalled()
    expect(getHardGuardPhase(AGENS), 'bukott restart utan az allapot nem mehet elore').not.toBe('await-ready')
  })
})
