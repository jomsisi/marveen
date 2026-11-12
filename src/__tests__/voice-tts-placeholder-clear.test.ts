// The voice-reply directive forbids a text reply, so a successful TTS send is
// the ONLY answer that reaches the chat -- yet the progress-placeholder
// bookkeeping used to hear only about the Telegram `reply` tool. The Stop hook
// then demanded a second, textual answer for a question already answered in
// voice (card stop-hook-hang-valasz-dupla-reply, michel 2026-11-12).
//
// Covered here:
//   1-4. the clearing contract itself (which entries go, which stay, and the
//        FAIL-CLOSED case: an unconfirmed send clears nothing);
//   5.   the two ends against the REAL Stop hook, as a pair: a plain text turn
//        with no reply must STILL block exactly once (negative control -- the
//        guarantee this fix must not weaken), while a turn answered by voice
//        must not block at all.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { clearPlaceholdersAfterVoiceDelivery } from '../web/telegram-progress.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STOP_HOOK = join(ROOT, 'scripts', 'hooks', 'telegram_progress_clear.py')

let server: Server
let apiBase = ''
let calls: { method: string; body: unknown }[] = []
let dir = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop() ?? ''
      let body: unknown = null
      try { body = JSON.parse(raw) } catch { /* ignore */ }
      calls.push({ method, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  apiBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  process.env['TELEGRAM_API_BASE'] = apiBase
})

afterAll(async () => {
  delete process.env['TELEGRAM_API_BASE']
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

// A state dir shaped like the channel plugin's: .env with the bot token, plus
// progress/<session>.json written by the UserPromptSubmit hook.
function stateDirWith(pending: Record<string, unknown[]>): string {
  const d = mkdtempSync(join(tmpdir(), 'tgprogress-'))
  writeFileSync(join(d, '.env'), 'TELEGRAM_BOT_TOKEN=123:TEST\n')
  mkdirSync(join(d, 'progress'))
  for (const [sid, entries] of Object.entries(pending)) {
    writeFileSync(join(d, 'progress', `${sid}.json`), JSON.stringify(entries))
  }
  return d
}

function runStopHook(stateDir: string, sessionId: string): { decision: string | null; stdout: string } {
  const p = spawnSync('python3', [STOP_HOOK], {
    input: JSON.stringify({ session_id: sessionId, stop_hook_active: false }),
    encoding: 'utf-8',
    timeout: 20_000,
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_API_BASE: apiBase },
  })
  const out = (p.stdout ?? '').trim()
  let decision: string | null = null
  if (out) { try { decision = (JSON.parse(out) as { decision?: string }).decision ?? null } catch { decision = `PARSE_ERROR:${out}` } }
  return { decision, stdout: out }
}

beforeEach(() => { calls = [] })

describe('clearPlaceholdersAfterVoiceDelivery', () => {
  it('drops the delivered chat and deletes its placeholder, keeping other chats', async () => {
    dir = stateDirWith({ 's1': [{ chat_id: '111', message_id: 9001 }, { chat_id: '222', message_id: 9002 }] })
    const dropped = await clearPlaceholdersAfterVoiceDelivery({ delivered: true, stateDir: dir, chatId: '111' })
    expect(dropped).toBe(1)
    expect(calls.map((c) => c.method)).toEqual(['deleteMessage'])
    expect(calls[0].body).toMatchObject({ chat_id: '111', message_id: 9001 })
    const left = JSON.parse(readFileSync(join(dir, 'progress', 's1.json'), 'utf-8')) as { chat_id: string }[]
    expect(left).toEqual([{ chat_id: '222', message_id: 9002 }])
  })

  it('removes the pending file when nothing is left for any chat', async () => {
    dir = stateDirWith({ 's1': [{ chat_id: '111', message_id: 9001 }, { chat_id: '111', message_id: 9003 }] })
    const dropped = await clearPlaceholdersAfterVoiceDelivery({ delivered: true, stateDir: dir, chatId: '111' })
    expect(dropped).toBe(2)
    expect(existsSync(join(dir, 'progress', 's1.json'))).toBe(false)
  })

  // FAIL-CLOSED: an unconfirmed send must leave the placeholder alone, so the
  // Stop hook still gets the user an answer.
  it('clears nothing when the send was not confirmed delivered', async () => {
    dir = stateDirWith({ 's1': [{ chat_id: '111', message_id: 9001 }] })
    const dropped = await clearPlaceholdersAfterVoiceDelivery({ delivered: false, stateDir: dir, chatId: '111' })
    expect(dropped).toBe(0)
    expect(calls).toEqual([])
    expect(existsSync(join(dir, 'progress', 's1.json'))).toBe(true)
  })

  it('is a silent no-op with no pending placeholder at all', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tgprogress-'))
    writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:TEST\n')
    const dropped = await clearPlaceholdersAfterVoiceDelivery({ delivered: true, stateDir: dir, chatId: '111' })
    expect(dropped).toBe(0)
    expect(calls).toEqual([])
  })
})

describe('the real Stop hook, both ends', () => {
  // NEGATIVE CONTROL: unchanged behaviour for a text turn that never replied.
  it('still blocks once when the turn ended with no answer at all', () => {
    dir = stateDirWith({ 'sid-text': [{ chat_id: '111', message_id: 9001 }] })
    const first = runStopHook(dir, 'sid-text')
    expect(first.decision).toBe('block')
    expect(existsSync(join(dir, 'progress', 'sid-text.json'))).toBe(true)
  })

  it('does not block after the answer went out as a voice message', async () => {
    dir = stateDirWith({ 'sid-voice': [{ chat_id: '111', message_id: 9001 }] })
    await clearPlaceholdersAfterVoiceDelivery({ delivered: true, stateDir: dir, chatId: '111' })
    const after = runStopHook(dir, 'sid-voice')
    expect(after.decision).toBe(null)
    expect(after.stdout).toBe('')
  })
})

// WIRING LINT. The two suites above prove the clearing CONTRACT, and would stay
// green if the /api/voice/tts route stopped calling it -- the exact defect class
// hook-registration-completeness.test.ts exists for ("unit-tested but wired
// nowhere"). The route itself cannot be driven from a test: it spawns piper and
// really sends a Telegram voice message. So the wiring is asserted on the source.
describe('the TTS route wiring', () => {
  const src = readFileSync(join(ROOT, 'src', 'web', 'routes', 'voice.ts'), 'utf-8')

  it('calls the clearing on the TTS success path, awaited', () => {
    expect(src).toContain("import { clearPlaceholdersAfterVoiceDelivery } from '../telegram-progress.js'")
    expect(src).toMatch(/await clearPlaceholdersAfterVoiceDelivery\(\{\s*delivered,\s*stateDir,\s*chatId\s*\}\)/)
  })

  // `delivered` must be the MEASURED send result -- the same value the response
  // reports as `ok`. A hardcoded true would clear the placeholder for a failed
  // send, which is the one direction that loses the answer for good.
  it('passes the measured send result, not a constant', () => {
    expect(src).toMatch(/const delivered = okMatch\?\.\[1\]\?\.toLowerCase\(\) === 'true'/)
    expect(src).toMatch(/json\(res, \{\s*ok: delivered,/)
  })
})
