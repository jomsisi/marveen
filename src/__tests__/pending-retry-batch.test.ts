import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import { summarizePendingRetryBatch } from '../pending-retries.js'

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

// --- Dispatch: N rows on one agent must cost ONE message ---

const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSendMessage = vi.fn(async (_token: string, _chatId: string, _text: string) => {})
const mockReady = vi.fn(() => false)

// Mirrors the real DB: `UPDATE ... WHERE alert_sent_at IS NULL` claims a row
// exactly ONCE. A mock that always returns true would hide the very guarantee
// this suite is about -- the runner ticks several times inside the test
// window, and with an always-true stamp every tick would re-alert.
const claimedRows = new Set<string>()
const mockMarkAlert = vi.fn((taskName: unknown, agentName: unknown) => {
  const key = `${String(taskName)}@${String(agentName)}`
  if (claimedRows.has(key)) return false
  claimedRows.add(key)
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
  markPendingTaskRetryAlert: (taskName: string, agentName: string, _ts: number) => mockMarkAlert(taskName, agentName),
  clearPendingTaskRetryAlert: vi.fn(),
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
    attempt_count: 40, last_reason: 'busy', alert_sent_at: null,
  }
}

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
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
