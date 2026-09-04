// Regression test for the relative helper-script paths in generated CLAUDE.md
// files (kanban card `agens-persona-relativ-helper-ut`, measured 2026-09-02).
//
// THE BUG. The scaffold emitted `bash scripts/dash-api.sh` and
// `bash scripts/agent-msg.sh`. Agents run with cwd = agents/<name>/, and no
// agent directory holds those helpers, so every such call died with "Nincs
// ilyen fajl vagy konyvtar". Same shape as the tokenPath fix of 2026-07-25 one
// level up: there a relative `store/.dashboard-token` made curl send an empty
// Bearer and 401 silently.
//
// WHY IT SURVIVED A CASUAL CHECK: a `scripts/` DIRECTORY does exist under four
// of the five agents -- with different contents, never the helper. Anyone
// testing for the directory passes and leaves the bug in place. And one agent
// appeared to work, because his commands happened to start with `cd <root> &&`
// out of habit; a rule kept by an accidental habit is not kept.
//
// WHY THE TWO ZONES ARE TESTED SEPARATELY, AND WHY BOTH ARE REQUIRED. The
// scaffold writes the helper path in two places that repair on OPPOSITE
// schedules, so fixing one leaves the other broken in the opposite direction:
//
//   ZONE A -- buildAutonomyBody, inside the autonomy-wiring markers.
//     ensureAutonomySection() rewrites it on every startAgentProcess(), so a
//     generator fix repairs all EXISTING agents at their next respawn. Tested
//     BEHAVIOURALLY below: we run the writer and read what landed on disk.
//
//   ZONE B -- the LLM prompt that authors a NEW agent's CLAUDE.md. It is copied
//     into the new file as ordinary prose, with NO markers around it, so
//     nothing repairs it afterwards: a new agent created from a relative
//     template stays broken forever. Tested as SOURCE SHAPE, because the text
//     only becomes a file by way of the LLM.
//
// A note for whoever measures this later: the CONTENT OF A GENERATED BLOCK IS
// NOT EVIDENCE ABOUT THE GENERATOR. Three of the five agent files were green on
// 2026-09-02 only because they carried a hand edit inside the markers, which
// their next respawn silently reverted (michel's did, within two days). Assert
// against the writer, as this file does -- never against a live agent's file.

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-abs-helper-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureAutonomySection } = await import('../web/agent-scaffold.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_PATH = join(__dirname, '..', 'web', 'agent-scaffold.ts')

// A helper invocation that would fail from an agent's cwd. Word-bounded on the
// script name so that a rename to `scripts/dash-api-v2.sh` is still caught, and
// anchored on `bash ` so prose mentioning the repo layout does not trip it.
const RELATIVE_HELPER_CALL = /\bbash\s+scripts\/(dash-api|agent-msg)[\w.-]*\.sh\b/

function writeAgentFile(name: string, content: string): string {
  const dir = join(tmpRoot, 'agents', name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'CLAUDE.md')
  writeFileSync(file, content, 'utf-8')
  return file
}

describe('ZONE A -- the generated autonomy block calls the helpers by absolute path', () => {
  it('writes absolute helper paths into the agent file', () => {
    const file = writeAgentFile('agent-b', '# agent-b\n\nSome existing persona text.\n')
    ensureAutonomySection('agent-b')
    const written = readFileSync(file, 'utf-8')

    // Both helpers appear, rooted at the install, not at the agent's cwd.
    expect(written).toContain(`bash ${join(tmpRoot, 'scripts')}/agent-msg.sh`)
    expect(written).toContain(`bash ${join(tmpRoot, 'scripts')}/dash-api.sh`)
  })

  it('leaves no relative helper call anywhere in the written file', () => {
    const file = writeAgentFile('agent-c', '# agent-c\n\nSome existing persona text.\n')
    ensureAutonomySection('agent-c')
    const written = readFileSync(file, 'utf-8')

    // The load-bearing assertion: not "an absolute path exists somewhere", but
    // "no relative one survives". A block containing both forms would pass the
    // test above and still hand the agent a command that fails.
    expect(written).not.toMatch(RELATIVE_HELPER_CALL)
  })

  it('roots the paths in PROJECT_ROOT rather than a baked-in install path', () => {
    const file = writeAgentFile('agent-d', '# agent-d\n')
    ensureAutonomySection('agent-d')
    const written = readFileSync(file, 'utf-8')

    // PROJECT_ROOT is mocked to a temp dir here, so a hardcoded
    // /root/marveen/... would fail this even though it is absolute -- that is
    // the distribution-safety half, and it is why the assertion is built from
    // tmpRoot instead of matching /^\//.
    const calls = written.match(/bash\s+(\S+?)\/(dash-api|agent-msg)\.sh/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call).toContain(tmpRoot)
  })
})

describe('ZONE B -- the new-agent prompt template teaches absolute helper paths', () => {
  const src = readFileSync(SCAFFOLD_PATH, 'utf-8')

  // Slice out the prompt exactly as agent-scaffold-claude-md-prompt.test.ts
  // does, so the two tests agree on what "the prompt" means.
  const promptStart = src.indexOf('export async function generateClaudeMd')
  const promptEnd = src.indexOf('export async function generateSoulMd')
  const promptBody = src.slice(promptStart, promptEnd)

  it('finds the prompt body (guards the slice itself)', () => {
    // Without this the two assertions below would pass vacuously on an empty
    // slice after any rename of either function.
    expect(promptStart).toBeGreaterThan(0)
    expect(promptEnd).toBeGreaterThan(promptStart)
    expect(promptBody).toContain('## Memoria rendszer')
  })

  it('uses the interpolated scripts directory, not a relative one', () => {
    expect(promptBody).not.toMatch(RELATIVE_HELPER_CALL)
    expect(promptBody).toContain('bash ${scriptsDir}/dash-api.sh')
    expect(promptBody).toContain('bash ${scriptsDir}/agent-msg.sh')
  })

  it('names the dashboard token by absolute path too', () => {
    // Same failure mode one field over: `cat store/.dashboard-token` from an
    // agent's cwd yields an empty Bearer and a silent 401 (measured
    // 2026-07-25). The prompt is prose, so this is the only place it is stated.
    expect(promptBody).not.toContain('a token a store/.dashboard-token fájlban')
    expect(promptBody).toContain('${tokenPath}')
  })
})

describe('the interpolated constants exist and are rooted at the install', () => {
  const src = readFileSync(SCAFFOLD_PATH, 'utf-8')

  it('declares scriptsDir from PROJECT_ROOT', () => {
    // Cheap structural guard: `${scriptsDir}` resolving to undefined would
    // produce "bash undefined/dash-api.sh" in the prompt, which the zone B
    // string assertions cannot see because they match the source, not the
    // rendered text.
    expect(src).toMatch(/const\s+scriptsDir\s*=\s*join\(\s*PROJECT_ROOT\s*,\s*'scripts'\s*\)/)
  })
})
