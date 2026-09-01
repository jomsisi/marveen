// Contract tests for the SECOND status-change path: updateKanbanCard, behind PUT /api/kanban/:id.
//
// moveKanbanCard has recorded a kanban_card_events row since the events table existed;
// updateKanbanCard wrote the same `status` column with no event at all. Two routes to one
// transition, one of them silent -- and the silence was invisible, because the card's own state
// came out correct either way. Measured 2026-08-31 on the live board: of the cards created after
// the events table started, 110 of 141 have no event at all.
//
// These call the real production entry points on an in-memory database, the same way
// kanban-move-audit.test.ts does; the route-level cases drive tryHandleKanban so the actor wiring
// is measured where it actually lives.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  initDatabase, createKanbanCard, updateKanbanCard, moveKanbanCard,
  getKanbanCardEvents, getKanbanCard,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
})

/** A PUT /api/kanban/<id> request against the real router. */
function putCtx(id: string, payload: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL(`http://localhost:3420/api/kanban/${encodeURIComponent(id)}`)
  return { ctx: { req, res, path: url.pathname, method: 'PUT', url } as RouteContext, out }
}

describe('kanban update audit trail', () => {
  it('records exactly one event with correct from/to status on a status change', () => {
    createKanbanCard({ id: 'card-a', title: 'Edited card' })

    expect(updateKanbanCard('card-a', { status: 'in_progress' }, 'sanyiba')).toBe(true)

    const events = getKanbanCardEvents('card-a')
    expect(events).toHaveLength(1)
    expect(events[0].from_status).toBe('planned')
    expect(events[0].to_status).toBe('in_progress')
    expect(events[0].actor).toBe('sanyiba')
    expect(typeof events[0].created_at).toBe('number')
  })

  it('records no event when the edit does not touch the status', () => {
    // The common case by far: a title or description edit from the dashboard form. If this wrote
    // an event, every wording fix would look like a status change in the timeline.
    createKanbanCard({ id: 'card-b', title: 'Card', description: 'before' })

    expect(updateKanbanCard('card-b', { description: 'after' }, 'sanyiba')).toBe(true)
    expect(getKanbanCardEvents('card-b')).toHaveLength(0)
    expect(getKanbanCard('card-b')?.description).toBe('after')
  })

  it('records no event when the status is re-sent unchanged', () => {
    // The dashboard form posts the whole card back, status included. Resending the same value is
    // not a transition, and the guard compares against the row as it stood BEFORE the write.
    createKanbanCard({ id: 'card-c', title: 'Card', status: 'waiting' })

    expect(updateKanbanCard('card-c', { status: 'waiting', title: 'Renamed' }, 'sanyiba')).toBe(true)
    expect(getKanbanCardEvents('card-c')).toHaveLength(0)
  })

  it('records no event when no row matches', () => {
    expect(updateKanbanCard('nonexistent-card', { status: 'done' }, 'sanyiba')).toBe(false)
    expect(getKanbanCardEvents('nonexistent-card')).toHaveLength(0)
  })

  it('leaves actor null when none is supplied', () => {
    // NOT merely backward compatibility: null is the DEFAULT, because the only identity available
    // on this path would come from a different namespace than the agent ids the column holds.
    createKanbanCard({ id: 'card-d', title: 'No actor' })

    expect(updateKanbanCard('card-d', { status: 'waiting' })).toBe(true)
    const events = getKanbanCardEvents('card-d')
    expect(events).toHaveLength(1)
    expect(events[0].actor).toBeNull()
  })

  it('the two paths write ONE chronological trail for the same card', () => {
    // The point of the fix: whichever route a transition took, the history reads as one sequence.
    createKanbanCard({ id: 'card-e', title: 'Both paths' })

    moveKanbanCard('card-e', 'in_progress', 0, 'boss')
    updateKanbanCard('card-e', { status: 'waiting' }, 'sanyiba')
    moveKanbanCard('card-e', 'done', 0, 'boss')

    const events = getKanbanCardEvents('card-e')
    expect(events.map((e) => e.to_status)).toEqual(['in_progress', 'waiting', 'done'])
    expect(events.map((e) => e.from_status)).toEqual(['planned', 'in_progress', 'waiting'])
    expect(events.map((e) => e.actor)).toEqual(['boss', 'sanyiba', 'boss'])
    for (let i = 1; i < events.length; i++) {
      expect(events[i].id).toBeGreaterThan(events[i - 1].id)
    }
  })

  it('PUT /api/kanban/:id records the transition, with the actor from the body', async () => {
    // The wiring, measured where it lives: without the route passing it on, the actor would be
    // null here and only the db-level tests above would notice the difference.
    createKanbanCard({ id: 'card-f', title: 'Through the route' })

    const { ctx, out } = putCtx('card-f', { status: 'done', actor: 'sanyiba' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body).toEqual({ ok: true })

    const events = getKanbanCardEvents('card-f')
    expect(events).toHaveLength(1)
    expect(events[0].from_status).toBe('planned')
    expect(events[0].to_status).toBe('done')
    expect(events[0].actor).toBe('sanyiba')
  })

  it('PUT /api/kanban/:id records the transition with a null actor when the body omits one', async () => {
    createKanbanCard({ id: 'card-g', title: 'Through the route, anonymous' })

    const { ctx } = putCtx('card-g', { status: 'done' })
    expect(await tryHandleKanban(ctx)).toBe(true)

    const events = getKanbanCardEvents('card-g')
    expect(events).toHaveLength(1)
    expect(events[0].to_status).toBe('done')
    expect(events[0].actor).toBeNull()
  })
})
