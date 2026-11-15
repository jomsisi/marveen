// Pure-logic helpers for the persistent scheduled-task retry queue.
//
// The scheduler used to keep busy-skipped tasks in an in-memory Map and
// abandon them after 15-60 minutes, silently. That failure mode is fatal
// for business-critical schedules (a morning summary that never arrives
// is only noticed hours later). The replacement policy is:
//
//   1. Every busy retry is upserted into `pending_task_retries` (persists
//      across dashboard restarts, so nothing is dropped).
//   2. On every tick, the scheduler tries to fire every pending row. On
//      success, the row is deleted; on continued busy, attempt_count ++.
//   3. If a row has been waiting longer than `ALERT_THRESHOLD_MS` and
//      `alert_sent_at` is null, the alerting layer stamps the row BEFORE
//      sending the Telegram message (so concurrent ticks do not
//      double-alert) and clears the stamp if the send fails (so the next
//      tick can retry). Net guarantee: one stamp per delivery attempt,
//      at-least-once delivery until success. The scheduled task itself
//      keeps retrying forever -- we do NOT abandon.
//
// This module contains the decision logic only; the I/O (DB + Telegram)
// lives in src/web.ts alongside the rest of the scheduler, but is wrapped
// behind small pure functions here so the "should we alert" decision can
// be unit-tested without a DB and without an HTTP mock.

/**
 * How long a busy-skipped scheduled task can wait before we escalate the
 * operator via Telegram. The retry itself continues forever: this is the
 * alerting threshold, not an abandon threshold.
 */
export const ALERT_THRESHOLD_MS = 60 * 60 * 1000

/**
 * How often an agent that is STILL stuck is escalated again, once its first
 * aggregated message has gone out (Zsolt's decision, 2026-10-23).
 *
 * A SEPARATE constant, not a reuse of ALERT_THRESHOLD_MS, because the two
 * answer different questions: the threshold above decides when a WAIT becomes
 * worth reporting, this one decides how often an unresolved OUTAGE is
 * repeated. Tying them together would mean a later tuning of either silently
 * moves the other.
 *
 * Why a repeat is needed at all: the per-row stamp is one-shot and the
 * per-agent throttle only delays, so once every stuck row has alerted, an
 * agent that stays stuck goes quiet -- which is the 2026-10-23 failure again,
 * just later in the timeline. The repeat is therefore AGENT-level and
 * time-based: it does not re-arm any row stamp.
 */
export const BATCH_REPEAT_INTERVAL_MS = 2 * 60 * 60 * 1000

/**
 * Additional wait AFTER the main-agent-notice threshold (ALERT_THRESHOLD_MS)
 * before escalating directly to the operator via the channel provider. Two
 * independent, one-shot stamps (`alert_sent_at` for the main-agent notice,
 * `owner_alert_sent_at` for the direct escalation) both key off
 * `first_attempt`, not off each other -- so a failure to deliver the
 * main-agent notice (e.g. a DB hiccup) can never silently suppress the final
 * escalation.
 */
export const OWNER_ESCALATION_EXTRA_MS = 75 * 60 * 1000
export const OWNER_ALERT_THRESHOLD_MS = ALERT_THRESHOLD_MS + OWNER_ESCALATION_EXTRA_MS

/**
 * Decide whether the alerting layer should fire a Telegram notification
 * for a pending retry row.
 *
 * Returns true only when:
 *   - the row has been waiting longer than `thresholdMs`, AND
 *   - no alert is currently stamped (`alertSentAt` is null).
 *
 * Callers are responsible for stamping `alert_sent_at` before the Telegram
 * send (race guard against concurrent ticks) and clearing it on delivery
 * failure so the next tick can retry.
 */
export function shouldSendAlert(
  now: number,
  firstAttempt: number,
  alertSentAt: number | null,
  thresholdMs: number = ALERT_THRESHOLD_MS,
): boolean {
  if (alertSentAt != null) return false
  if (!Number.isFinite(firstAttempt) || firstAttempt <= 0) return false
  if (!Number.isFinite(now) || now < firstAttempt) return false
  return now - firstAttempt > thresholdMs
}

/** What an aggregated escalation says about one agent's stuck rows. */
export interface PendingRetryBatchSummary {
  agentName: string
  taskNames: string[]
  count: number
  /** Age of the OLDEST row, in whole minutes. */
  oldestMinutes: number
  /** Distinct reason KINDS, `mcp-missing:<server>` collapsed to its kind. */
  reasons: string[]
  /** The single reason kind when every row shares one, else null. */
  commonReason: string | null
}

/**
 * Whether an aggregated escalation may be sent for this agent now.
 *
 * Why a throttle is part of the fix and not a nicety: on 2026-10-23 the ten
 * rows did NOT mature together. Their first_attempt values were staggered by
 * ~10 minutes (the alert log shows ageMinutes 60 at 11:10, 11:20, 11:30,
 * 11:30, 11:40, 11:50, 12:00, 13:00, 13:40, 18:00), so the 60-minute
 * threshold came due in a DIFFERENT tick for almost every row. Grouping only
 * the rows due in the same tick would therefore have aggregated nothing --
 * nine or ten groups of one, i.e. the same ten messages with better wording.
 *
 * So the group is every row still stuck on the agent, and the message is
 * rate-limited per agent to one per threshold window. The per-row stamp stays
 * the per-row throttle; this is the per-AGENT one.
 */
export function shouldSendBatchAlert(
  now: number,
  lastSentAt: number | null,
  thresholdMs: number = ALERT_THRESHOLD_MS,
): boolean {
  if (lastSentAt == null) return true
  if (!Number.isFinite(now) || !Number.isFinite(lastSentAt)) return false
  return now - lastSentAt >= thresholdMs
}

/**
 * Summarize a group of due retry rows for ONE agent.
 *
 * Why this is a decision and not formatting: the per-row alert already
 * worked -- on 2026-10-23 it sent ten messages, one per stuck task, each at
 * 60 minutes, and nine hours passed with no action. What none of the ten
 * said was that every scheduled task on that agent was stuck behind ONE
 * cause. `commonReason` is that sentence's subject: one distinct kind means
 * one fix, several means the agent is down in more than one way and the
 * operator needs the list.
 *
 * Reason kinds are split on ':' so `mcp-missing:foo` and `mcp-missing:bar`
 * count as one cause -- the fix (restart the MCP) is the same.
 */
export function summarizePendingRetryBatch(
  views: Array<{ taskName: string, agentName: string, ageMs: number, lastReason: string | null }>,
): PendingRetryBatchSummary | null {
  if (views.length === 0) return null
  const reasons = [...new Set(views.map(v => (v.lastReason ?? 'busy').split(':')[0]))]
  return {
    agentName: views[0].agentName,
    taskNames: views.map(v => v.taskName),
    count: views.length,
    oldestMinutes: Math.max(...views.map(v => Math.floor(v.ageMs / 60000))),
    reasons,
    commonReason: reasons.length === 1 ? reasons[0] : null,
  }
}

/**
 * Classify a channel send failure as transient (worth retrying) or
 * permanent (a config / client error that will fail identically every
 * tick). Provider-agnostic entry point: the scheduler alert path sends over
 * whatever channel the main agent is bound to (Telegram or Slack), so this
 * dispatches on the provider prefix to a per-provider classifier below.
 *
 * Telegram (channel-provider telegramProvider / sendTelegramMessage) throws
 * `Error("Telegram API <status>: ...")` on a non-2xx response. Slack
 * (slackProvider.sendMessage) throws `Error("Slack API HTTP <status>")` on a
 * transport-level non-2xx and `Error("Slack API error: <code>")` when the
 * API returns `ok:false`. A bare network error (TypeError "fetch failed")
 * carries no status on either provider.
 *
 *   - transient: network failure (no status), HTTP 429 (rate limited),
 *     any 5xx, or a Slack `ratelimited`/`internal_error`-class code. The
 *     next tick should retry, so the caller clears the per-attempt stamp.
 *   - permanent: HTTP 4xx other than 429 (400 bad chat_id, 401/404 bad
 *     token, 403 blocked), or a Slack config code (channel_not_found,
 *     invalid_auth, token_revoked, not_in_channel, ...). Retrying every
 *     tick just spams the log with the identical failure, so the caller
 *     KEEPS the stamp until the underlying config is fixed.
 *
 * Pure (takes the error message string) so it is unit-testable without a
 * live endpoint.
 */
export function classifySendError(errMessage: string): 'transient' | 'permanent' {
  if (errMessage.includes('Telegram API')) return classifyTelegramError(errMessage)
  if (errMessage.includes('Slack API')) return classifySlackError(errMessage)
  if (errMessage.includes('Discord API')) return classifyDiscordError(errMessage)
  return 'transient' // no recognized provider prefix -> network-level failure
}

/** Shared HTTP-status policy: 429 and 5xx retry, other 4xx is config. */
function classifyHttpStatus(status: number): 'transient' | 'permanent' {
  if (status === 429 || status >= 500) return 'transient'
  if (status >= 400) return 'permanent'
  return 'transient'
}

/** Telegram: "Telegram API <status>: ...". */
function classifyTelegramError(errMessage: string): 'transient' | 'permanent' {
  const match = /Telegram API (\d{3})\b/.exec(errMessage)
  return match ? classifyHttpStatus(Number(match[1])) : 'transient'
}

/** Discord (discordProvider.sendMessage): "Discord API <status>: <body>".
 *  Same HTTP-status policy -- without this branch a bad channel id / revoked
 *  bot token (4xx) fell through as "transient" and respun every 60s. */
function classifyDiscordError(errMessage: string): 'transient' | 'permanent' {
  const match = /Discord API (\d{3})\b/.exec(errMessage)
  return match ? classifyHttpStatus(Number(match[1])) : 'transient'
}

/**
 * Slack application-level error codes that are worth retrying; everything
 * else (bad channel/token/scope) is a config error that will fail
 * identically next tick.
 */
const SLACK_TRANSIENT_CODES = new Set([
  'ratelimited', 'rate_limited', 'internal_error', 'service_unavailable',
  'fatal_error', 'request_timeout', 'timeout',
])

/**
 * Slack: "Slack API HTTP <status>" (transport-level non-2xx) or
 * "Slack API error: <code>" (API returned ok:false).
 */
function classifySlackError(errMessage: string): 'transient' | 'permanent' {
  const httpStatus = /Slack API HTTP (\d{3})\b/.exec(errMessage)
  if (httpStatus) return classifyHttpStatus(Number(httpStatus[1]))
  const code = /Slack API error:\s*([a-z_]+)/i.exec(errMessage)
  if (code) return SLACK_TRANSIENT_CODES.has(code[1].toLowerCase()) ? 'transient' : 'permanent'
  return 'transient'
}

/**
 * Backward-compatible alias. The classifier is provider-agnostic now
 * (see classifySendError); the old name is kept so existing call sites and
 * tests continue to resolve.
 */
export const classifyTelegramSendError = classifySendError

/**
 * Shape of a pending retry used by the UI + the alert layer. A small
 * subset of the DB row, decoupled from the DB type so tests don't need
 * better-sqlite3.
 */
export interface PendingRetryView {
  id: number
  taskName: string
  agentName: string
  firstAttempt: number
  lastAttempt: number
  attemptCount: number
  lastReason: string | null
  alertSentAt: number | null
  ageMs: number
  alertDue: boolean
  // Stage 2: direct-to-owner channel escalation, only after the main-agent
  // notice (alertDue/alertSentAt, stage 1) has had OWNER_ESCALATION_EXTRA_MS
  // to be seen and acted on.
  ownerAlertSentAt: number | null
  ownerAlertDue: boolean
}

/**
 * Project a raw DB row into the UI view, including the derived `ageMs`
 * (for display) and `alertDue` (= shouldSendAlert). Keeping the derivation
 * here means the UI never has to carry the alert policy.
 */
export function toPendingRetryView(
  row: {
    id: number
    task_name: string
    agent_name: string
    first_attempt: number
    last_attempt: number
    attempt_count: number
    last_reason: string | null
    alert_sent_at: number | null
    owner_alert_sent_at?: number | null
  },
  now: number,
  thresholdMs: number = ALERT_THRESHOLD_MS,
  ownerThresholdMs: number = OWNER_ALERT_THRESHOLD_MS,
): PendingRetryView {
  return {
    id: row.id,
    taskName: row.task_name,
    agentName: row.agent_name,
    firstAttempt: row.first_attempt,
    lastAttempt: row.last_attempt,
    attemptCount: row.attempt_count,
    lastReason: row.last_reason,
    alertSentAt: row.alert_sent_at,
    ageMs: Math.max(0, now - row.first_attempt),
    alertDue: shouldSendAlert(now, row.first_attempt, row.alert_sent_at, thresholdMs),
    ownerAlertSentAt: row.owner_alert_sent_at ?? null,
    ownerAlertDue: shouldSendAlert(now, row.first_attempt, row.owner_alert_sent_at ?? null, ownerThresholdMs),
  }
}
