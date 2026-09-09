import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'

// The skill-usage-capture hook shipped fully tested (#607) but was registered
// NOWHERE: templates/settings.json.template never referenced it, so on every
// scaffolded agent the skill_usage table stayed silently empty while the
// /skill-usage dashboard and the dream-engine suggestions ran on no data.
// A hook that only exists on disk is dead code -- these tests pin the wiring,
// not the (already unit-tested) capture logic.
//
// SCOPE -- what a green run here does and does not say, and where the rest lives.
// Measured: what these tests assert (templates/settings.json.template), where the
// running fleet's registration actually sits, and that the hook fires.
//   MEASURED HERE: templates/settings.json.template -- the starting config a
//     SCAFFOLDED agent is created with. Asserting on the template is correct:
//     the scaffold reads it, so this is the file that decides what a new agent
//     gets. Nothing more is claimed.
//   NOT MEASURED HERE: the live config of an ALREADY RUNNING instance, in
//     particular the hand-written main-agent .claude/settings.json. That file is
//     edited by hand and drifts from the template on purpose; green here says
//     nothing about it, and a project-level .claude/settings.json with no
//     skill-usage-capture entry is NOT evidence of a missing hook.
//   WHERE THE ANSWER ABOUT THE RUNNING SYSTEM LIVES -- two addresses, and the
//     second is not optional:
//       1. the USER-level ~/.claude/settings.json, whose hook commands carry
//          absolute checkout paths -- that is where a hand-configured main
//          agent's registration actually is. Reading a narrower layer and
//          finding nothing yields a false zero, not a finding.
//       2. the skill_usage table in store/claudeclaw.db -- fresh rows prove the
//          hook RUNS. The config only proves it is REGISTERED, which is a
//          different claim, and only the table can tell the two apart.

type Hook = { type?: string; command?: string; timeout?: number }
type HookEntry = { matcher?: string; hooks?: Hook[] }

const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
const tpl = JSON.parse(readFileSync(tplPath, 'utf-8')) as {
  hooks?: Record<string, HookEntry[]>
}

function commandsOf(event: string): string[] {
  return (tpl.hooks?.[event] ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ''))
}

describe('skill-usage-capture registration', () => {
  it('the template registers the hook under PostToolUse', () => {
    const cmds = commandsOf('PostToolUse')
    expect(cmds.some((c) => c.includes('skill-usage-capture.py'))).toBe(true)
  })

  it('uses the fail-open wrapper so a missing file never blocks the tool call', () => {
    const cmd = commandsOf('PostToolUse').find((c) => c.includes('skill-usage-capture.py'))!
    // Same shape as the other guarded hooks: file-existence test, exec on hit,
    // exit 0 otherwise. A bare `python3 <path>` would exit 2 after the checkout
    // moves and a non-zero hook surfaces as an error on every matched tool.
    expect(cmd).toMatch(/^bash -c '\[ -f [^']*skill-usage-capture\.py \] && exec python3 /)
    expect(cmd).toMatch(/; exit 0'$/)
  })

  it('matches only the tools the hook classifies (Skill calls and SKILL.md Reads)', () => {
    const entry = (tpl.hooks?.PostToolUse ?? []).find((e) =>
      (e.hooks ?? []).some((h) => (h.command ?? '').includes('skill-usage-capture.py')),
    )!
    expect(entry.matcher).toBe('Skill|Read')
  })

  it('is a known hook script, so the stale-entry pruner may clean it up', () => {
    // Without this, a stale registration (deleted checkout) would be treated as
    // FOREIGN by pruneStaleHookEntries and kept forever.
    expect(KNOWN_HOOK_SCRIPTS).toContain('skill-usage-capture.py')
  })
})
