import {
  createAgentMessage, getPendingMessages, listAgentMessages,
  getAgentConversation, getAgentConversationThreads,
  getKanbanSeqByIdPrefix,
  markMessageDone, markMessageFailed, getAgentMessage,
  closeOtelSpan,
  getPendingBacklogByAgent,
  COMPLETION_REPORT_PREFIX,
  type AgentMessage,
} from '../../db.js'
import { logger } from '../../logger.js'
import { COORDINATOR_AGENT_ID } from '../../channel-coordinator/ingest.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { isKnownAgent } from '../agent-config.js'
import { OWNER_NAME } from '../../config.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { parseQualifiedId, formatQualifiedId } from '../federation/address.js'
import { getFederationConfig } from '../federation/config.js'
import type { RouteContext } from './types.js'

/**
 * Should closing `done` produce a completion notification back to its sender?
 *
 * Three separate reasons to stay silent, and each one is a bug we have already paid for:
 *
 *  1. SELF-MESSAGE -- nobody to tell.
 *  2. THE MESSAGE IS ITSELF A COMPLETION REPORT (`[Eredmény]` prefix). Without this the
 *     delegator's reply would close the notification, which would notify back, forever.
 *  3. THE SENDER IS NOT A RUNNABLE AGENT. The notification is addressed to the ORIGINAL
 *     SENDER, and that is not always something with a session: the `system` pseudo-sender
 *     posts new-teammate notices and handoff-failure warnings. A notification addressed to
 *     it can never be delivered -- the router burns the whole retry window, then emits a
 *     `[handoff-failure]`, which does NOT start with `[Eredmény]`, so closing THAT would
 *     produce another undeliverable notification. Measured 2026-08-10: a self-sustaining
 *     chain, not one-off noise (kanban f0601aff).
 *     What must NOT be done instead: silencing the handoff-failure warning. That warning is
 *     the only signal we get when a REAL sub-agent session is dead. The notification is what
 *     must not be created.
 */
export function shouldNotifyDelegator(done: AgentMessage): boolean {
  if (done.from_agent === done.to_agent) return false
  if (done.content.startsWith('[Eredmény]')) return false
  return isKnownAgent(done.from_agent)
}

/**
 * How much of a `result` travels inside the completion notification, and what the recipient
 * is told about the rest.
 *
 * WHY THIS IS NOT COSMETIC (measured twice on 2026-08-12): the notification carried the first
 * 500 characters and then said "the full text is in msg N's result field". Both times the cut
 * landed mid-argument -- once on a review condition, once on the numbers that decided whether a
 * filter was safe -- and both times the recipient could only ask for a resend, because the
 * pointer named a FIELD, not a way to read it. A pointer the consumer cannot follow is the same
 * as no pointer: the sender ends up retyping, which is exactly what the notification was for.
 *
 * TWO CHANGES, AND THE SECOND MATTERS MORE. The cap is 2000, because our results routinely
 * carry a measurement plus its interpretation and 500 truncates that mid-sentence. And the
 * marker now names the EXACT command, so following it is one step, not a research task.
 *
 * The cap stays FINITE on purpose: the notification is injected into a live session, and an
 * unbounded paste there costs context that the recipient did not choose to spend.
 */
export const RESULT_NOTIFY_MAX = 2000

export function resultSummary(id: number, result: string | undefined | null): string {
  if (!result) return '(nincs eredmény)'
  if (result.length <= RESULT_NOTIFY_MAX) return result
  const maradt = result.length - RESULT_NOTIFY_MAX
  return (
    result.slice(0, RESULT_NOTIFY_MAX) +
    `\n... [levágva, még ${maradt} karakter. A TELJES szöveg: bash scripts/agent-msg-get.sh ${id}]`
  )
}

export async function tryHandleMessages(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/messages' && method === 'POST') {
    const body = await readBody(req)
    const { from, to, content, origin_note } = JSON.parse(body.toString()) as
      { from: string; to: string; content: string; origin_note?: string }
    if (!from?.trim() || !to?.trim() || !content?.trim()) {
      json(res, { error: 'from, to, and content are required' }, 400)
      return true
    }
    // Security: the channel-coordinator id grants channel-inbound delivery
    // (verbatim <channel> + reply-expected framing) in the message-router. The
    // ONLY legitimate writer of that id is the in-process coordinator, which
    // inserts directly into the DB -- it never POSTs here. The dashboard token
    // is readable by every sub-agent, so without this guard any sub-agent could
    // forge a reply-expected message addressed at the main agent. Reject it.
    //
    // CRITICAL: normalize with the EXACT function the router matches on
    // (sanitizeAgentIdent), NOT from.trim(). The router does
    // CHANNEL_COORDINATOR_AGENTS.has(sanitizeAgentIdent(from)), and
    // sanitizeAgentIdent STRIPS [^a-zA-Z0-9_-] rather than trimming. A bypass
    // like from="@telegram-coordinator" / "telegram-coordinator." survives
    // .trim() (!= the constant) yet sanitizes to "telegram-coordinator" in the
    // router -> channel-inbound with an attacker-controlled body. Matching the
    // router's normalization here closes that asymmetry.
    if (sanitizeAgentIdent(from) === COORDINATOR_AGENT_ID) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST forging channel-coordinator id')
      json(res, { error: 'from is reserved for the in-process channel coordinator' }, 403)
      return true
    }
    // Federation spoof guard: a slash-qualified from ("teodor/teodor") is the
    // provenance mark of a REMOTE sender and may only ever be written by the
    // token-authenticated /api/federation/inbox. Accepting it here would let
    // any dashboard-token holder (i.e. every local sub-agent) impersonate a
    // federation peer toward another local agent.
    if (from.includes('/')) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST with qualified from (federation impersonation guard)')
      json(res, { error: 'from must be a local agent id without "/" -- federated senders are only accepted via /api/federation/inbox' }, 403)
      return true
    }
    // From-authentication: accept messages only from registered fleet agents.
    // The shared Bearer token is readable by any sub-agent, so without this
    // check any process with the token could inject messages as an arbitrary
    // sender ("from": "zack" from an external attacker who obtained the token).
    // Server-side validation: the `from` claim must match a known agent on the
    // filesystem (agents/<id>/ directory, or MAIN_AGENT_ID). This is not
    // impersonation-proof between fleet agents (they share the same token) but
    // it closes the "unknown sender" injection path without per-agent secrets.
    //
    // The human OWNER is a legitimate sender too: the dashboard "Messages" page
    // composes with from=OWNER_NAME (resolveOwnerName -> the owner assignee), so
    // without this exemption the operator's own dashboard messages 403 with
    // "unknown agent". The owner is not a fleet agent (no agents/<id>/ dir), so
    // isKnownAgent alone rejects it. Match on the router's normalization to stay
    // symmetric with the other guards above.
    const isOwnerSender = sanitizeAgentIdent(from) === sanitizeAgentIdent(OWNER_NAME)
    if (!isOwnerSender && !isKnownAgent(sanitizeAgentIdent(from))) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST from unregistered agent')
      json(res, { error: `unknown agent '${from.trim()}' -- from must be a registered fleet agent id` }, 403)
      return true
    }
    // Qualified to ("peer/agent"): validate at creation time so the sender
    // gets an actionable error NOW instead of a silent 1h abandon. Local
    // (slash-free) recipients are untouched.
    let storedTo = to.trim()
    if (storedTo.includes('/')) {
      const target = parseQualifiedId(storedTo)
      if (!target) {
        json(res, { error: 'Invalid federated address in to (expected "<system>/<agent>")' }, 400)
        return true
      }
      const cfg = getFederationConfig()
      if (!cfg.enabled) {
        json(res, { error: 'Federation is disabled on this system' }, 400)
        return true
      }
      // System ids are case-insensitive (stored lowercase in the config).
      // Normalize the STORED prefix too: the per-peer purge SQL and the
      // bridge's peer lookup key on it, and thread grouping in the UI should
      // not split 'Teodor/x' from 'teodor/x'. The agent segment is the
      // PEER's namespace -- leave its case alone.
      const targetSystem = target.system.toLowerCase()
      if (targetSystem === cfg.systemId) {
        json(res, { error: `'${target.system}' is this system -- address the agent locally as '${target.agent}'` }, 400)
        return true
      }
      if (!cfg.peers.some((p) => p.id === targetSystem)) {
        json(res, { error: `Unknown federation peer '${target.system}'` }, 400)
        return true
      }
      storedTo = formatQualifiedId(targetSystem, target.agent)
    } else if (storedTo.includes(':')) {
      // A colon-form 'to' ("federation:teodor:teodor", copied from an
      // <untrusted source> attribute) is NOT a valid address: it has no '/',
      // so it would be treated as a LOCAL recipient, never match a session,
      // and silently sit pending until the 1h abandon window. Reject it now
      // with the correct form. Safe: sanitizeAgentIdent strips ':', so no
      // legitimate local agent id can contain one, and the channel
      // coordinator inserts directly into the DB, bypassing this endpoint.
      json(res, { error: 'Invalid recipient: use "<system>/<agent>" (slash) for a federated address, not the "federation:x:y" source form' }, 400)
      return true
    }
    // Code-side enforcement of the kanban-ref convention: rewrite any
    // `#<hex8>` token that maps to a real kanban_cards row into its
    // human-facing `#<seq>` form before persistence, so the dashboard and
    // every downstream consumer sees the canonical reference even when a
    // sub-agent forgets the CLAUDE.md rule (#75 Cuzcoo dispatch).
    const normalizedContent = normalizeKanbanRefs(content.trim(), getKanbanSeqByIdPrefix)
    // Card 06f062e4: optional attributability tag, self-declared like `from`
    // itself -- capped short so it stays a label, not a second content field.
    const trimmedOriginNote = origin_note?.trim().slice(0, 120) || null
    const msg = createAgentMessage(from.trim(), storedTo, normalizedContent, trimmedOriginNote)
    logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent, originNote: msg.origin_note }, 'Agent message created')
    json(res, msg)
    return true
  }

  // Sidebar threads: one row per conversation peer (system agents excluded),
  // each with its count + most-recent message, recency computed per-peer.
  if (path === '/api/messages/threads' && method === 'GET') {
    json(res, getAgentConversationThreads())
    return true
  }

  // Backlog per agent: count + how long the oldest has been waiting. Cheap
  // enough to curl on a schedule; the point is that a growing queue behind a
  // busy agent becomes visible BEFORE someone mistakes it for lost messages.
  if (path === '/api/messages/backlog' && method === 'GET') {
    json(res, getPendingBacklogByAgent())
    return true
  }

  if (path === '/api/messages' && method === 'GET') {
    const agent = url.searchParams.get('agent') || ''
    const status = url.searchParams.get('status') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const beforeRaw = url.searchParams.get('before')
    const before = beforeRaw !== null ? parseInt(beforeRaw, 10) : undefined

    let messages: AgentMessage[]
    if (status === 'pending' && agent) {
      messages = getPendingMessages(agent)
    } else if (status === 'pending') {
      messages = getPendingMessages()
    } else if (agent) {
      // SQL-filtered to THIS agent's last N (+ before-cursor pagination), not
      // global-last-N-then-JS-filter which starved rarely-active threads.
      messages = getAgentConversation(agent, limit, Number.isFinite(before as number) ? before : undefined)
    } else {
      messages = listAgentMessages(limit)
    }

    jsonMaybeGzip(req, res, messages)
    return true
  }

  const msgUpdateMatch = path.match(/^\/api\/messages\/(\d+)$/)
  // EGY uzenet a TELJES tartalmaval -- ezt nevezi meg a levagott ertesites markere.
  // A lista-vegpont csak agens szerint kerdezheto, tehat egy `msg N` hivatkozast eddig
  // nem lehetett egy lepesben kovetni.
  if (msgUpdateMatch && method === 'GET') {
    const one = getAgentMessage(parseInt(msgUpdateMatch[1], 10))
    if (!one) { json(res, { error: 'Message not found' }, 404); return true }
    json(res, one)
    return true
  }
  if (msgUpdateMatch && method === 'PUT') {
    const id = parseInt(msgUpdateMatch[1], 10)
    const body = await readBody(req)
    const { status: newStatus, result } = JSON.parse(body.toString()) as { status: string; result?: string }

    let ok = false
    if (newStatus === 'done') ok = markMessageDone(id, result)
    else if (newStatus === 'failed') ok = markMessageFailed(id, result)

    if (ok) {
      const done = getAgentMessage(id)
      // Close the OTel span now that the message has a terminal status.
      if (done?.trace_id && done?.span_id) {
        closeOtelSpan(done.trace_id, done.span_id, Date.now(), newStatus === 'done' ? 'ok' : 'error')
      }
      // Notify the delegator: create a reverse message from executor → delegator so
      // they learn the result without polling. The full rule lives in
      // shouldNotifyDelegator() so it can be measured without driving the route.
      if (done && shouldNotifyDelegator(done)) {
        // A vagas NE legyen nema, ES legyen KOVETHETO: lasd resultSummary().
        const summary = resultSummary(id, result)
        createAgentMessage(
          done.to_agent,
          done.from_agent,
          `${COMPLETION_REPORT_PREFIX} msg_id:${id} status:${newStatus}\n\n${summary}`,
        )
      }
      json(res, { ok: true }); return true
    }
    json(res, { error: 'Message not found or invalid status' }, 404)
    return true
  }

  return false
}
