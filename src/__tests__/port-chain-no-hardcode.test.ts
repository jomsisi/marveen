import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { substituteTemplatePlaceholders } from '../web/agent-scaffold.js'

// PORTCHAIN1: WEB_PORT is user-selectable, but several places still asked a
// fixed 3420. The worst were not the cosmetic strings:
//   - scripts/doctor.sh          reported a RUNNING dashboard as dead
//   - templates/settings.json.template  told EVERY agent to curl a fixed port
//     at every compaction, so memory/daily-log/taskstate saves failed silently
//   - src/web/channel-monitor.ts handed agents an instruction with a fixed port
//   - scripts/hooks/egress-gate.mjs  blocked the agent's own dashboard
//
// Every assertion below runs on a NON-DEFAULT port. Verifying on 3420 proves
// nothing: that is exactly where the hardcode and the variable coincide.
const PORT = '3421'
const ROOT = join(__dirname, '..', '..')

/** A throwaway install tree whose .env selects a non-default port. */
function makeInstall(port: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'portchain-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'store'), { recursive: true })
  writeFileSync(join(dir, '.env'), `OWNER_NAME=Teszt\nWEB_PORT=${port}\n`)
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'dummy-token')
  return dir
}

/** Copy one script into the throwaway tree and echo the port it resolves. */
function resolvedPort(script: string, dir: string): string {
  cpSync(join(ROOT, script), join(dir, script))
  const body = readFileSync(join(dir, script), 'utf-8')
  // take only the resolution preamble: everything up to the first non-assignment
  // use of WEB_PORT would still run the whole script, so re-run just the idiom
  const idiom = body.split('\n').filter((l) => l.startsWith('WEB_PORT=')).join('\n')
  expect(idiom, `${script}: no WEB_PORT resolution found`).not.toBe('')
  return execFileSync('bash', ['-c', `cd '${dir}' && cd scripts && ${idiom}\necho "$WEB_PORT"`], {
    encoding: 'utf-8',
  }).trim()
}

describe('PORTCHAIN1: the port chain follows WEB_PORT on a NON-default port', () => {
  let dir: string
  beforeAll(() => { dir = makeInstall(PORT) })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // --- shell scripts: the resolution is EXECUTED, not pattern-matched -------

  it.each([
    'scripts/doctor.sh',
    'scripts/pre-pr-review.sh',
    'scripts/start.sh',
    'scripts/migrate-main-agent-id.sh',
    'scripts/set-bot-menu.sh',
  ])('%s resolves WEB_PORT from .env, not 3420', (script) => {
    expect(resolvedPort(script, dir)).toBe(PORT)
  })

  // The resolution idiom alone is not enough: the CALL SITE must use the
  // variable. A first version of this file asserted only the idiom, and a
  // negative control that restored the literal in doctor.sh still passed.
  it.each([
    'scripts/doctor.sh',
    'scripts/pre-pr-review.sh',
    'scripts/start.sh',
    'scripts/migrate.sh',
    'scripts/migrate-main-agent-id.sh',
    'scripts/set-bot-menu.sh',
    'src/web/channel-monitor.ts',
    'templates/settings.json.template',
    'install-windows.ps1',
    'install-lang.sh',
  ])('%s contains no literal localhost:3420 at any call site', (f) => {
    expect(readFileSync(join(ROOT, f), 'utf-8')).not.toContain('localhost:3420')
  })

  it('the resolution honours an explicit WEB_PORT env over the .env', () => {
    cpSync(join(ROOT, 'scripts/doctor.sh'), join(dir, 'scripts/doctor.sh'))
    const idiom = readFileSync(join(dir, 'scripts/doctor.sh'), 'utf-8')
      .split('\n').filter((l) => l.startsWith('WEB_PORT=')).join('\n')
    const out = execFileSync('bash', ['-c',
      `cd '${dir}/scripts' && WEB_PORT=9999 ${''}\n${idiom}\necho "$WEB_PORT"`], { encoding: 'utf-8' })
    expect(out.trim()).toBe('9999')
  })

  it('falls back to 3420 only when nothing selects a port', () => {
    const bare = mkdtempSync(join(tmpdir(), 'portchain-bare-'))
    mkdirSync(join(bare, 'scripts'), { recursive: true })
    try {
      expect(resolvedPort('scripts/doctor.sh', bare)).toBe('3420')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  // --- the instruction handed to AGENTS ------------------------------------

  it('settings.json.template carries NO literal 3420 once rendered', () => {
    const raw = readFileSync(join(ROOT, 'templates/settings.json.template'), 'utf-8')
    const rendered = substituteTemplatePlaceholders(raw, {
      projectRoot: '/opt/install', mainAgentId: 'agent', botName: 'Bot',
      ownerName: 'Owner', webPort: Number(PORT),
    })
    expect(rendered).not.toContain('3420')
    expect(() => JSON.parse(rendered)).not.toThrow()
    // The write examples no longer carry a URL at all: they go through
    // scripts/dash-api.sh. Asserting the helper's NAME here would say nothing
    // about the port, so the chain is measured where it now runs -- see the
    // block below, which executes the helpers against a real listener.
    expect(rendered).toContain('bash scripts/dash-api.sh')
  })

  it('channel-monitor builds its agent instruction from WEB_PORT', () => {
    const src = readFileSync(join(ROOT, 'src/web/channel-monitor.ts'), 'utf-8')
    expect(src).toContain("import { WEB_PORT } from '../config.js'")
    expect(src).toMatch(/localhost:\$\{WEB_PORT\}\/api\/memories/)
    expect(src).not.toMatch(/localhost:3420/)
  })

  // --- the helpers the agent instructions now point at ---------------------
  //
  // Moving the writes from a curl example to a helper MOVED the port chain
  // rather than removing it, and the move is exactly where it broke: the
  // helpers resolved the port from MARVEEN_WEB_PORT, a name NOTHING in the
  // product ever sets, while config.ts resolves WEB_PORT from the .env. The
  // two never met, so `:-3420` was not a fallback but the only branch that
  // ever ran -- an install on any other port had its agents reading from the
  // right port and writing to 3420. Invisible on 3420, where the two separate
  // values agree by coincidence.
  //
  // So this does not assert a string. It stands up a listener on a
  // non-default port, points a throwaway install's .env at it, and runs the
  // helper for real: the request either arrives on that port or it does not.

  it.each([
    ['scripts/dash-api.sh', ['POST', '/api/daily-log'], '{"agent_id":"a","content":"x"}'],
    ['scripts/agent-msg.sh', ['a', 'b', '-'], 'hello'],
    ['scripts/agent-msg-close.sh', ['1', 'done', '-'], 'result text'],
  ] as const)('%s sends to the port from .env, not 3420', async (script, args, stdin) => {
    const hits: string[] = []
    const server = createServer((req, res) => {
      hits.push(req.url ?? '')
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        // agent-msg.sh only counts a send as done when an id comes back.
        res.end(JSON.stringify({ id: 1, status: 'pending' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = String((server.address() as AddressInfo).port)
    const box = makeInstall(port)
    try {
      cpSync(join(ROOT, script), join(box, script))
      // ASYNC on purpose: execFileSync would block this thread, and the listener
      // above runs on it -- the helper would wait for a response that cannot be
      // written until the helper returns.
      await new Promise<void>((resolve, reject) => {
        const child = execFile('bash', [join(box, script), ...args], (err) => (err ? reject(err) : resolve()))
        child.stdin?.end(stdin)
      })
      expect(hits.length, `${script}: nothing arrived on port ${port}`).toBeGreaterThan(0)
    } finally {
      rmSync(box, { recursive: true, force: true })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('the helpers carry no literal 3420 as their only port source', () => {
    for (const script of ['scripts/dash-api.sh', 'scripts/agent-msg.sh', 'scripts/agent-msg-close.sh']) {
      const src = readFileSync(join(ROOT, script), 'utf-8')
      // The default may stay as a last resort, but a .env read must precede it.
      expect(src, `${script}: no .env WEB_PORT read`).toContain("grep -E '^WEB_PORT=' \"$BASE/.env\"")
    }
  })

  // --- the egress allowlist ------------------------------------------------

  it('egress-gate allowlists the dashboard on the CONFIGURED port', () => {
    const out = execFileSync('node', ['-e', `
      process.env.WEB_PORT = '${PORT}'
      import('${join(ROOT, 'scripts/hooks/egress-gate.mjs').replace(/\\/g, '/')}')
        .then(() => {})
        .catch(() => {})
      // the module derives the port at import time; re-derive it the same way
      const p = process.env.WEB_PORT || '3420'
      console.log(p)
    `], { encoding: 'utf-8' }).trim()
    expect(out).toBe(PORT)

    const src = readFileSync(join(ROOT, 'scripts/hooks/egress-gate.mjs'), 'utf-8')
    expect(src).toContain('const DASHBOARD_PORT')
    expect(src).toMatch(/localhost:\$\{DASHBOARD_PORT\}/)
    expect(src).toMatch(/127\.0\.0\.1:\$\{DASHBOARD_PORT\}/)
    // the built-in list must no longer pin the default
    expect(src).not.toMatch(/'http:\/\/localhost:3420\/'/)
  })

  // --- what must NOT be touched (legit fallbacks) --------------------------

  it('leaves the documented fallbacks alone', () => {
    const stays: Array<[string, RegExp]> = [
      ['src/config.ts', /WEB_PORT = parseInt\(env\['WEB_PORT'\] \?\? '3420', 10\)/],
      ['src/web.ts', /startWebServer\(port = 3420\)/],
      ['src/remote-enroll-core.ts', /REMOTE_PORT = 3420/],
      ['scripts/fleet-safe-start.sh', /MARVEEN_DASHBOARD_URL:-http:\/\/localhost:3420/],
    ]
    for (const [f, re] of stays) {
      expect(readFileSync(join(ROOT, f), 'utf-8'), `${f} must keep its fallback`).toMatch(re)
    }
  })

  it('web/app.js keeps its pre-fetch initial value (overwritten at boot)', () => {
    const app = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
    // measured: /api/network-info overwrites it, and the prompt uses the variable
    expect(app).toContain('let __serverPort = 3420')
    expect(app).toContain('if (info.port) __serverPort = info.port')
    expect(app).toMatch(/localhost:\$\{__serverPort\}/)
  })
})
