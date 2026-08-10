import { describe, it, expect, vi } from 'vitest'
import type { AgentMessage } from '../db.js'

// WHAT THIS MEASURES: closing a message must NOT produce a completion notification when the
// original sender is not a runnable agent.
//
// The notification is addressed to the ORIGINAL SENDER. The `system` pseudo-sender posts
// new-teammate notices and handoff-failure warnings but owns no session, so a notification
// addressed to it can never be delivered: the router burns the full retry window and then
// emits a `[handoff-failure]` -- which does NOT start with `[Eredmény]`, so closing that one
// would create yet another undeliverable notification. Measured 2026-08-10 on the live boss
// inbox: 973 closed -> 974 to system (failed) -> 1005 handoff-failure -> ... a self-sustaining
// chain, not one-off noise (kanban f0601aff).
//
// isKnownAgent() is mocked rather than backed by a directory fixture, because what this file
// is about is the DECISION, not how agent existence is looked up. The mock names exactly one
// real agent, so the positive control below cannot pass by accident.
vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: (name: string) => name === 'sanyiba' || name === 'boss',
}))

const { shouldNotifyDelegator } = await import('../web/routes/messages.js')

function msg(from: string, to: string, content: string): AgentMessage {
  return {
    id: 1, from_agent: from, to_agent: to, content,
    status: 'done', created_at: 0,
  } as AgentMessage
}

describe('shouldNotifyDelegator', () => {
  it('notifies a real agent -- POSITIVE CONTROL, without this the rest proves nothing', () => {
    // Ha ez nincs itt, a fajl ugyanigy zold lenne akkor is, ha a fuggveny MINDIG false-t adna --
    // es akkor egy zajos hurkot csereltunk volna nema delegalasra.
    expect(shouldNotifyDelegator(msg('sanyiba', 'boss', 'Kerlek nezd at'))).toBe(true)
  })

  it('stays silent when the sender is the `system` pseudo-agent (the self-sustaining chain)', () => {
    expect(shouldNotifyDelegator(msg('system', 'boss', 'Uj csapattag erkezett: safar'))).toBe(false)
  })

  it('stays silent for a handoff-failure notice -- it does not start with the sentinel', () => {
    const m = msg('system', 'boss', '[handoff-failure] Inter-agent message (id 974) ...')
    expect(m.content.startsWith('[Eredmény]')).toBe(false) // EZ engedte at a regi szuron
    expect(shouldNotifyDelegator(m)).toBe(false)
  })

  it('keeps the two older guards: self-message and completion report', () => {
    expect(shouldNotifyDelegator(msg('boss', 'boss', 'sajat magamnak'))).toBe(false)
    expect(shouldNotifyDelegator(msg('sanyiba', 'boss', '[Eredmény] msg_id:42 status:done'))).toBe(false)
  })
})
