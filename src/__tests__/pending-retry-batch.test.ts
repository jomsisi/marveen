import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import { summarizePendingRetryBatch, shouldSendBatchAlert, ALERT_THRESHOLD_MS } from '../pending-retries.js'

// AGGREGATED escalation for the 2026-10-23 outage.
//
// The per-row alert was not missing and it was not late: it fired ten times
// between 11:10 and 18:00, one message per stuck task, each at ageMinutes 60
// (ALERT_THRESHOLD_MS is 60 minutes, and `first_attempt` is never reset by
// the retry upsert, so the threshold worked exactly as designed). Nine hours
// passed with no action anyway, because ten messages that each name ONE task
// and close with "the system keeps retrying" never say the sentence that
// mattered: every scheduled task on this agent is stuck behind one cause.
//
// So the threshold is unchanged and no second one is added. What changed is
// the delivery: due rows are grouped per agent, and a group names the common
// cause once.

describe('summarizePendingRetryBatch (pure)', () => {
  const view = (taskName: string, lastReason: string | null, ageMin: number) => ({
    taskName, agentName: 'boss', ageMs: ageMin * 60_000, lastReason,
  })

  it('names the single shared cause and the oldest age', () => {
    const s = summarizePendingRetryBatch([
      view('gls-szamla-tovabbitas', 'busy', 61),
      view('kanban-audit', 'busy', 184),
      view('mvm-szamla-tovabbitas', 'busy', 95),
    ])
    expect(s).not.toBe(null)
    expect(s!.agentName).toBe('boss')
    expect(s!.count).toBe(3)
    expect(s!.commonReason).toBe('busy')
    expect(s!.oldestMinutes).toBe(184)
    expect(s!.taskNames).toEqual(['gls-szamla-tovabbitas', 'kanban-audit', 'mvm-szamla-tovabbitas'])
  })

  it('collapses mcp-missing:<server> to one cause -- the fix is the same', () => {
    const s = summarizePendingRetryBatch([
      view('a', 'mcp-missing:alkotmany', 70),
      view('b', 'mcp-missing:iskb', 70),
    ])
    expect(s!.commonReason).toBe('mcp-missing')
    expect(s!.reasons).toEqual(['mcp-missing'])
  })

  it('refuses a common cause when the agent is down in more than one way', () => {
    const s = summarizePendingRetryBatch([
      view('a', 'busy', 70),
      view('b', 'first-run', 70),
    ])
    expect(s!.commonReason).toBe(null)
    expect(s!.reasons).toEqual(['busy', 'first-run'])
  })

  it('treats a null reason as busy and an empty group as nothing to say', () => {
    expect(summarizePendingRetryBatch([view('a', null, 70)])!.commonReason).toBe('busy')
    expect(summarizePendingRetryBatch([])).toBe(null)
  })
})

describe('shouldSendBatchAlert (pure)', () => {
  const T = 1_000_000_000_000
  it('speaks when this agent has not been reported yet', () => {
    expect(shouldSendBatchAlert(T, null)).toBe(true)
  })
  it('stays quiet inside the window and speaks once it has passed', () => {
    expect(shouldSendBatchAlert(T + ALERT_THRESHOLD_MS - 1, T)).toBe(false)
    expect(shouldSendBatchAlert(T + ALERT_THRESHOLD_MS, T)).toBe(true)
  })
  it('refuses on a non-finite clock rather than guessing', () => {
    expect(shouldSendBatchAlert(Number.NaN, T)).toBe(false)
    expect(shouldSendBatchAlert(T, Number.NaN)).toBe(false)
  })
})

// --- Dispatch: N rows on one agent must cost ONE message ---

const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSendMessage = vi.fn(async (_token: string, _chatId: string, _text: string) => {})
const mockReady = vi.fn(() => false)

// Mirrors the real DB: `UPDATE ... WHERE alert_sent_at IS NULL` claims a row
// exactly ONCE. A mock that always returns true would hide the very guarantee
// this suite is about -- the runner ticks several times inside the test
// window, and with an always-true stamp every tick would re-alert.
const claimedRows = new Set<string>()
// MERGE (v1.37.0): the owner-facing message now claims the OWNER stamp
// (owner_alert_sent_at); the alert_sent_at stamp belongs to upstream's stage-1
// main-agent notice, which is a different message (an inter-agent one).
const mockMarkAlert = vi.fn((taskName: string, agentName: string, ts: number) => {
  const key = `${taskName}@${agentName}`
  if (claimedRows.has(key)) return false
  claimedRows.add(key)
  // Mirror the real UPDATE: the stamp lands ON THE ROW, so the next tick's
  // toPendingRetryView sees alertDue=false. A mock that only remembered the
  // key kept every row "due" forever and hid an early return that made the
  // two-hour repeat unreachable in production.
  for (const r of mockListPendingRetries() as Array<Record<string, unknown>>) {
    if (r.task_name === taskName && r.agent_name === agentName) r.owner_alert_sent_at = ts
  }
  return true
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: vi.fn(),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => true),
  clearPendingTaskRetryAlert: vi.fn(),
  markPendingTaskRetryOwnerAlert: (taskName: string, agentName: string, ts: number) => mockMarkAlert(taskName, agentName, ts),
  clearPendingTaskRetryOwnerAlert: vi.fn(),
  createAgentMessage: vi.fn(() => 0),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))
// The alert path resolves a REAL install-level token (HOME-based, a test
// worktree does not isolate it). Neutralize the SINK so a green suite never
// costs the operator attention, but keep it observable: the assertion here is
// about HOW MANY messages the tick sends.
vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    getProvider: (type: Parameters<typeof real.getProvider>[0]) => ({
      ...real.getProvider(type),
      sendMessage: mockSendMessage,
      sendPhoto: vi.fn(async () => {}),
    }),
  }
})
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-retry-batch-no-tasks-dir',
}))
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => mockReady(),
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

const TASKS = ['gls-szamla-tovabbitas', 'zd-jovairo-tovabbitas', 'kanban-audit']

function task(name: string): ScheduledTask {
  return {
    name, schedule: '0 8 * * *', description: 'batch fixture', prompt: 'Do the thing.',
    agent: 'boss', enabled: true, createdAt: 0, type: 'task', targetSession: 'boss-channels',
  }
}

function row(name: string, ageMin: number) {
  const now = Date.now()
  return {
    task_name: name, agent_name: 'boss',
    first_attempt: now - ageMin * 60_000,
    last_attempt: now - 60_000,
    attempt_count: 40, last_reason: 'busy', alert_sent_at: null, owner_alert_sent_at: null,
  }
}

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

// Let the runner tick for a stretch of fake time, so a row's AGE grows past
// the threshold mid-run -- the staggered case cannot be expressed in one tick.
async function runTicksFor(ms: number) {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(ms)
  clearInterval(stop)
}

describe('schedule runner: due alerts are grouped per agent', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T10:30:00.000Z'))
    mockListScheduledTasks.mockReturnValue(TASKS.map(task))
    claimedRows.clear()
    mockReady.mockReturnValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('sends ONE message for three stuck tasks, naming all three and the cause', async () => {
    mockListPendingRetries.mockReturnValue([row(TASKS[0], 184), row(TASKS[1], 95), row(TASKS[2], 61)])
    await runOneTick()

    // Every row still gets its own stamp -- the once-per-row guarantee is the
    // throttle, and grouping must not weaken it. The runner ticks several
    // times inside the window, so what is pinned is the number of rows
    // CLAIMED (3), not the number of attempts.
    expect(claimedRows.size).toBe(3)

    // ...but the operator gets ONE message, not three.
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    const text = String(mockSendMessage.mock.calls[0][2])
    for (const name of TASKS) expect(text).toContain(name)
    expect(text).toContain('3 ütemezett feladata EGYSZERRE áll')
    expect(text).toContain('184 perce')
    expect(text).toContain('Közös ok')
  })

  it('keeps the per-task text when only one task is stuck', async () => {
    mockListPendingRetries.mockReturnValue([row(TASKS[0], 184)])
    await runOneTick()

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    const text = String(mockSendMessage.mock.calls[0][2])
    expect(text).toContain(TASKS[0])
    expect(text).toContain('184 perce várakozik')
    expect(text).not.toContain('EGYSZERRE áll')
  })

  it('says nothing when no row has crossed the threshold', async () => {
    mockListPendingRetries.mockReturnValue([row(TASKS[0], 10), row(TASKS[1], 20)])
    await runOneTick()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockMarkAlert).not.toHaveBeenCalled()
  })
})

// THE REAL SHAPE, and the one the first version of this fix got wrong.
//
// The ten rows of 2026-10-23 did not mature together: their first_attempt
// values were ~10 minutes apart (the alert log shows ageMinutes 60 at 11:10,
// 11:20, 11:30, 11:30, 11:40, 11:50, 12:00, 13:00, 13:40, 18:00), so the
// 60-minute threshold came due in a DIFFERENT tick for nearly every row.
// Grouping only the rows due in the SAME tick aggregates nothing there: nine
// or ten groups of one, i.e. the same ten messages with better wording.
describe('schedule runner: staggered rows still produce ONE message', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T10:30:00.000Z'))
    mockListScheduledTasks.mockReturnValue(TASKS.map(task))
    claimedRows.clear()
    mockReady.mockReturnValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('counts every stuck row on the first due tick, not just the due one', async () => {
    // Only the 61-minute row is due; the others are 10 and 20 minutes short.
    mockListPendingRetries.mockReturnValue([row(TASKS[0], 61), row(TASKS[1], 51), row(TASKS[2], 41)])
    await runTicksFor(2 * 60_000)

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    const text = String(mockSendMessage.mock.calls[0][2])
    // The message names all THREE, although only one crossed the threshold.
    expect(text).toContain('3 ütemezett feladata EGYSZERRE áll')
    for (const name of TASKS) expect(text).toContain(name)
    expect(text).toContain('61 perce')
    // ...and only the due row's stamp was spent.
    expect(claimedRows.size).toBe(1)
  })

  it('promises exactly the repeat the code keeps', async () => {
    // The closing line may name an interval only because the repeat is now
    // agent-level and time-based, so it does not depend on a row stamp that
    // can be spent once. It must not claim the 60-minute threshold: that one
    // governs the FIRST message, and an operator told "an hour" would start
    // waiting at the wrong time.
    mockListPendingRetries.mockReturnValue([row(TASKS[0], 61), row(TASKS[1], 51), row(TASKS[2], 41)])
    await runTicksFor(2 * 60_000)

    const text = String(mockSendMessage.mock.calls[0][2])
    expect(text).toContain('2 óránként megismétlem')
    expect(text).not.toMatch(/egy óra múlva|60 perc/)
  })

  it('does not repeat itself as the remaining rows come due inside the window', async () => {
    mockListPendingRetries.mockReturnValue([row(TASKS[0], 61), row(TASKS[1], 51), row(TASKS[2], 41)])
    // 25 minutes of ticks: the 51- and 41-minute rows cross 60 too.
    await runTicksFor(25 * 60_000)

    // Every row spends its own stamp -- the per-row guarantee is untouched...
    expect(claimedRows.size).toBe(3)
    // ...but the operator hears about this agent ONCE in the window.
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  // --- The two-hour repeat (Zsolt's decision, 2026-10-23) ---
  //
  // Why 119/125 and not 119/121: the first message goes out on the runner's
  // FIRST tick, at +61s, so the repeat window opens at ~121 minutes of run
  // time. Pinning 121 would make the assertion depend on the tick phase, not
  // on the interval -- a test that passes or fails by a second is not
  // measuring the thing it names.

  it('stays quiet for two hours after the first message', async () => {
    mockListPendingRetries.mockReturnValue([row(TASKS[0], 61), row(TASKS[1], 51), row(TASKS[2], 41)])
    await runTicksFor(119 * 60_000)
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  it('repeats once the two hours have passed, while the rows are still stuck', async () => {
    mockListPendingRetries.mockReturnValue([row(TASKS[0], 61), row(TASKS[1], 51), row(TASKS[2], 41)])
    await runTicksFor(125 * 60_000)

    expect(mockSendMessage).toHaveBeenCalledTimes(2)
    // The repeat is NOT driven by row stamps -- all three were spent in the
    // first hour -- and it reports the same stuck group, aged further.
    expect(claimedRows.size).toBe(3)
    const second = String(mockSendMessage.mock.calls[1][2])
    expect(second).toContain('3 ütemezett feladata EGYSZERRE áll')
    expect(second).toContain('2 óránként megismétlem')
  })

  it('goes quiet when the queue drains -- a resolved outage is not repeated', async () => {
    const t0 = Date.now()
    const rows = [row(TASKS[0], 61), row(TASKS[1], 51), row(TASKS[2], 41)]
    // The tasks finally run at +150 minutes: from then on nothing is stuck.
    mockListPendingRetries.mockImplementation(() => (Date.now() >= t0 + 150 * 60_000 ? [] : [...rows]))
    await runTicksFor(300 * 60_000)

    // First message, then the one repeat at ~121 -- and nothing after the
    // queue emptied, although another five repeat windows went by.
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })

  it('does not throttle the FIRST message of the next outage', async () => {
    // The discriminating case for clearing the repeat window on drain. The
    // new outage's first message falls 99 minutes after the last pre-drain
    // message -- inside the two-hour interval. If the window survived the
    // drain, this report would be silently throttled, and missing the FIRST
    // report is the one failure this alert may not have.
    const t0 = Date.now()
    const first = [row(TASKS[0], 61), row(TASKS[1], 51)]
    const later = [
      { ...row(TASKS[2], 0), task_name: 'kupon-szamla-figyeles', first_attempt: t0 + 160 * 60_000 },
      { ...row(TASKS[2], 0), task_name: 'mvm-szamla-tovabbitas', first_attempt: t0 + 160 * 60_000 },
    ]
    mockListPendingRetries.mockImplementation(() => {
      const now = Date.now()
      if (now >= t0 + 160 * 60_000) return [...later]
      if (now >= t0 + 150 * 60_000) return []
      return [...first]
    })
    mockListScheduledTasks.mockReturnValue(
      [...TASKS, 'kupon-szamla-figyeles', 'mvm-szamla-tovabbitas'].map(task),
    )
    await runTicksFor(230 * 60_000)

    // first message (~1), repeat (~121), then the NEW outage's first (~220).
    expect(mockSendMessage).toHaveBeenCalledTimes(3)
    expect(String(mockSendMessage.mock.calls[2][2])).toContain('2 ütemezett feladata EGYSZERRE áll')
  })

  it('counts a task that JOINS the queue in the next repeat', async () => {
    // The queue is re-read every tick, so a task that enters later (on
    // 2026-10-23 the 18:00 alert's row was first attempted at 17:00) is part
    // of the stuck group from then on, and the next repeat counts it. The
    // second message here is the two-hour repeat, not a second first-message.
    // Build the rows ONCE: `row()` reads Date.now(), so composing them inside
    // the implementation would re-stamp first_attempt on every tick and the
    // ages would never grow -- a fixture that quietly freezes the clock.
    const t0 = Date.now()
    const early = [row(TASKS[0], 61), row(TASKS[1], 51)]
    const late = { ...row(TASKS[2], 0), first_attempt: t0 + 70 * 60_000 }
    mockListPendingRetries.mockImplementation(() =>
      Date.now() >= t0 + 70 * 60_000 ? [...early, late] : [...early],
    )
    await runTicksFor(140 * 60_000)

    expect(mockSendMessage).toHaveBeenCalledTimes(2)
    // The first message knows nothing of the late task...
    expect(String(mockSendMessage.mock.calls[0][2])).toContain('2 ütemezett feladata EGYSZERRE áll')
    // ...the second counts all three.
    expect(String(mockSendMessage.mock.calls[1][2])).toContain('3 ütemezett feladata EGYSZERRE áll')
    expect(claimedRows.size).toBe(3)
  })
})
