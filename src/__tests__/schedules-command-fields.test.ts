import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Regression: `POST /api/schedules` answered 200 and created a task that did
// NOTHING. `type: 'command'` tasks are defined entirely by `command` (+
// `timeoutMs`, `failThreshold`) -- see scheduled-tasks-io.ts:43-48 -- and the
// route's request type did not list those three fields, so JSON.parse kept them
// but the handler never forwarded them to writeScheduledTask. The writer has
// always supported them (scheduled-tasks-io.ts:198-200); only the route dropped
// them. Measured 2026-09-16 (sanyiba created `memoria-index-meret-or` through
// the API and had to hand-edit task-config.json afterwards).
//
// SCOPE -- read before trusting the green: these are SOURCE-TEXT assertions, the
// idiom this repo already uses for route contracts. They pin that the three
// identifiers reach the writer call and that the prompt requirement is branched
// on the type. They do NOT execute the handler, so they cannot catch a runtime
// regression that keeps the text and changes the behaviour. The negative control
// was run: against the pre-fix source every assertion below fails.

const ROUTE = readFileSync(join(__dirname, '../web/routes/schedules.ts'), 'utf-8')

const postHandler = (() => {
  const start = ROUTE.indexOf("if (path === '/api/schedules' && method === 'POST')")
  expect(start).toBeGreaterThan(-1)
  const end = ROUTE.indexOf('const scheduleUpdateMatch', start)
  expect(end).toBeGreaterThan(start)
  return ROUTE.slice(start, end)
})()

describe('POST /api/schedules forwards the command-type fields', () => {
  it('the request type declares command, timeoutMs and failThreshold', () => {
    expect(postHandler).toMatch(/command\?: string/)
    expect(postHandler).toMatch(/timeoutMs\?: number/)
    expect(postHandler).toMatch(/failThreshold\?: number/)
  })

  it('all three are passed to writeScheduledTask, not just parsed', () => {
    const call = postHandler.slice(postHandler.indexOf('writeScheduledTask('))
    const args = call.slice(0, call.indexOf('})') + 2)
    expect(args).toMatch(/command: data\.command/)
    expect(args).toMatch(/timeoutMs: data\.timeoutMs/)
    expect(args).toMatch(/failThreshold: data\.failThreshold/)
  })
})

describe('POST /api/schedules asks for the field the type actually uses', () => {
  it('type=command requires `command` instead of `prompt`', () => {
    expect(postHandler).toMatch(/data\.type === 'command'/)
    expect(postHandler).toMatch(/Command is required for type=command/)
  })

  it('the prompt requirement is the ELSE branch, not unconditional', () => {
    // The pre-fix source rejected a command task with "Prompt is required"
    // although the prompt is never read for that type.
    expect(postHandler).toMatch(/} else if \(!data\.prompt\?\.trim\(\)\)/)
  })
})

describe('PUT /api/schedules/:name forwards them too', () => {
  it('the update request type declares the three fields', () => {
    const start = ROUTE.indexOf('scheduleUpdateMatch && method === \'PUT\'')
    const put = ROUTE.slice(start, ROUTE.indexOf('writeScheduledTask(name, data)', start))
    expect(put).toMatch(/command\?: string/)
    expect(put).toMatch(/timeoutMs\?: number/)
    expect(put).toMatch(/failThreshold\?: number/)
  })
})
