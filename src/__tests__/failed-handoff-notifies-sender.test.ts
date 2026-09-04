// The sender of an abandoned inter-agent message must learn that it never arrived.
//
// THE GAP, MEASURED 2026-09-04 (card f2bcc921). Message 4989 (sanyiba -> a
// non-existent recipient) was abandoned after the full retry window. The
// `[handoff-failure]` notice went `system -> boss`; the SENDER got nothing and
// could not have found out alone. The endpoint had accepted the send with HTTP
// 200 and an id, so by our own send contract it looked successful for an hour.
//
// IT IS AN ASYMMETRY, NOT A MISSING MECHANISM, and that is why the fix is small:
//   federated path (message-router.ts:293, :330) -> notifyDelegationFailed() -> the SENDER
//   local path     (message-router.ts:555, :741) -> notifyOrchestratorOfFailedHandoff() -> the MAIN AGENT
// The local path is the common one. Both should reach the sender.
//
// WHY THE LOOP BRANCH IS TESTED FIRST, AND WHY IT IS NOT HYPOTHETICAL. A notice
// addressed to a party that owns no session can never be delivered: the router
// burns the full retry window and emits ANOTHER handoff-failure, which would
// again try to notify its sender -- a self-sustaining chain. That exact chain
// ran on the live boss inbox on 2026-08-10 (973 closed -> 974 to system, failed
// -> 1005 handoff-failure -> ...; kanban f0601aff), and the header of
// notify-delegator-known-agent.test.ts records it. Extending sender
// notification to the LOCAL path multiplies how often that door is opened, so
// the guard is part of the change, not a follow-up.
//
// NOTE THE GUARD ALSO COVERS THE EXISTING FEDERATED CALLS: today lines 293/330
// call notifyDelegationFailed with no runnability check at all -- only a status
// guard against double-notification. Routing both paths through one predicate
// closes that latent door too.

import { describe, it, expect, vi } from 'vitest'

// isKnownAgent is mocked rather than backed by a directory fixture: what this
// file measures is the DECISION, not how agent existence is looked up. The mock
// names exactly two real agents, so the positive control cannot pass by accident.
vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: (name: string) => name === 'sanyiba' || name === 'boss',
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => null,
}))

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'boss',
}))

const { shouldNotifyFailedSender } = await import('../web/message-router.js')

describe('THE LOOP BRANCH FIRST: a notice must never be addressed to a party with no session', () => {
  it('does not notify the `system` pseudo-sender', () => {
    // `system` posts new-teammate notices and handoff-failure warnings but owns
    // no session. This is the exact link that made the 2026-08-10 chain
    // self-sustaining: the undeliverable notice produced the next failure,
    // which produced the next notice.
    expect(shouldNotifyFailedSender('system')).toBe(false)
  })

  it('does not notify a sender that is no longer a known agent', () => {
    // A removed or renamed agent leaves rows behind whose from_agent no longer
    // resolves. Same shape as `system`: nobody drains that inbox, so the notice
    // burns a retry window and emits its own failure.
    expect(shouldNotifyFailedSender('deleted-agent')).toBe(false)
  })

  it('does not notify a sender whose name is empty', () => {
    // Defensive: an empty from_agent would address the notice to nobody, and
    // isKnownAgent('') is false, so this must fall on the same side.
    expect(shouldNotifyFailedSender('')).toBe(false)
  })
})

describe('the main agent is not notified twice', () => {
  it('does not add a sender notice when the sender IS the main agent', () => {
    // The orchestrator notice already goes to MAIN_AGENT_ID. A second one for
    // the same event would be noise in the one inbox that reads everything --
    // and noise in that inbox is how a real handoff-failure stops being read.
    expect(shouldNotifyFailedSender('boss')).toBe(false)
  })
})

describe('THE HAPPY PATH: a runnable sender does get told', () => {
  it('notifies a known, non-main sender', () => {
    // The measured case: sanyiba sent 4989 and was never told it failed.
    expect(shouldNotifyFailedSender('sanyiba')).toBe(true)
  })

  it('POSITIVE CONTROL ON THE MOCK: the false cases are not false for a trivial reason', () => {
    // Without this, a mock that returned false for EVERYTHING would make every
    // assertion above pass while measuring nothing. The mock knows exactly two
    // agents; one of them must come back true.
    expect(shouldNotifyFailedSender('sanyiba')).toBe(true)
    expect(shouldNotifyFailedSender('boss')).toBe(false)
  })
})

describe('the decision CANNOT depend on the recipient', () => {
  it('takes the sender only -- a structural guarantee, not a behavioural one', () => {
    // An earlier draft of this file took (fromAgent, toAgent) and looped over
    // recipients. That would have proved only that TODAY the second argument is
    // ignored; a later edit could fold recipient logic in and quietly narrow
    // which failures reach their sender, with every assertion still green.
    // A one-parameter function cannot develop that dependency at all, so the
    // ARITY is the guarantee -- and this is what pins it.
    expect(shouldNotifyFailedSender.length).toBe(1)
  })
})
