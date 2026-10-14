import { spawn, spawnSync } from "node:child_process"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { STORE_DIR, TELEGRAM_BOT_TOKEN } from "../config.js"
import { resolveOwnerChatId } from "../owner-chat.js"
import { atomicWriteFileSync } from "./atomic-write.js"
import { logger } from "../logger.js"
import { sendTelegramMessage } from "./telegram.js"
import { appendTaskRun } from "../db.js"
import type { ScheduledTask } from "./scheduled-tasks-io.js"

// command-type scheduled tasks run a raw shell command directly (no LLM
// agent, no tmux session) and alert on Telegram after N consecutive
// failures. This keeps infra heartbeats inside the one system that gets
// backed up (the Marveen store) instead of a separate crontab.

const HEALTH_PATH = join(STORE_DIR, "command-task-health.json")

export interface CommandHealth {
  fails: number
  alerted: boolean
  lastStatus: "ok" | "fail" | "unknown"
  lastRun: number
}
type HealthMap = Record<string, CommandHealth>

let healthMap: HealthMap | null = null
function load(): HealthMap {
  if (healthMap) return healthMap
  try { healthMap = JSON.parse(readFileSync(HEALTH_PATH, "utf-8")) as HealthMap }
  catch { healthMap = {} }
  return healthMap
}
function persist(): void {
  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap ?? {}, null, 2)) }
  catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
}

export type CommandAction = "none" | "alert" | "recover"

// Pure decision function so the failure/recovery policy is unit-testable
// without spawning processes. success=true zeroes the streak; an alert
// fires exactly once when the streak first reaches failThreshold; a
// recover fires once when a previously-alerted task succeeds again.
export function evaluateCommandResult(
  prev: CommandHealth | undefined,
  success: boolean,
  failThreshold: number,
  now: number,
): { next: CommandHealth; action: CommandAction } {
  const wasAlerted = prev?.alerted ?? false
  const fails = success ? 0 : (prev?.fails ?? 0) + 1
  let action: CommandAction = "none"
  let alerted = wasAlerted
  if (success) {
    if (wasAlerted) { action = "recover"; alerted = false }
  } else if (fails >= failThreshold && !wasAlerted) {
    action = "alert"; alerted = true
  }
  return {
    next: { fails, alerted, lastStatus: success ? "ok" : "fail", lastRun: now },
    action,
  }
}

function runCommand(cmd: string, timeoutMs: number): { ok: boolean; detail: string } {
  try {
    const r = spawnSync("bash", ["-lc", cmd], { timeout: timeoutMs, encoding: "utf-8" })
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code
      if (code === "ETIMEDOUT") return { ok: false, detail: `timeout ${timeoutMs}ms` }
      return { ok: false, detail: r.error.message }
    }
    if (r.status === 0) return { ok: true, detail: "exit 0" }
    const err = (r.stderr || "").trim().slice(0, 200)
    return { ok: false, detail: `exit ${r.status}${err ? ": " + err : ""}` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

// Async twin of runCommand. Same contract ({ok, detail}), delivered via
// callback instead of a return value, so the scheduler loop is NOT blocked
// while the command runs.
//
// WHY THIS EXISTS (measured 2026-09-20): spawnSync blocks the Node event
// loop for the whole run. Three command tasks POST to this same dashboard,
// so they deadlock against their own server and are only released by the
// timeout -- which the runner then books as a failure and reports to
// Telegram as a red alert. Measured: memoria-tukor sat at 600s (its full
// timeout) three days running, holding the dashboard unresponsive from
// 08:40 to 08:50 every morning, and three false red alerts went out.
//
// The stdout/stderr pipes MUST be drained here: unlike spawnSync, an
// unread pipe fills up and stalls the child.
export function runCommandAsync(
  cmd: string,
  timeoutMs: number,
  done: (r: { ok: boolean; detail: string }) => void,
): void {
  let settled = false
  const finish = (r: { ok: boolean; detail: string }) => {
    if (settled) return
    settled = true
    done(r)
  }
  try {
    const child = spawn("bash", ["-lc", cmd], { stdio: ["ignore", "pipe", "pipe"] })
    let err = ""
    let timedOut = false
    // KNOWN LIMIT, carried over from the sync path and measured 2026-09-20:
    // this kills the direct `bash` child only, NOT its grandchildren. A
    // timed-out task's own children (typically curl) keep running, and their
    // output lands in the task's log AFTER the runner has already booked the
    // run as a timeout. That is why an `OK id=<n>` line can sit under a run
    // recorded as "timeout 30000ms". So: the log order does NOT prove what
    // the runner saw. Anything read out of `detail` stops at this boundary.
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, timeoutMs)
    child.stdout?.on("data", () => { /* drain, the task owns its own logging */ })
    child.stderr?.on("data", (d: Buffer) => { if (err.length < 2000) err += d.toString() })
    child.on("error", (e: Error) => { clearTimeout(timer); finish({ ok: false, detail: e.message }) })
    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      if (timedOut) return finish({ ok: false, detail: `timeout ${timeoutMs}ms` })
      if (code === 0) return finish({ ok: true, detail: "exit 0" })
      const tail = err.trim().slice(0, 200)
      finish({ ok: false, detail: `exit ${code}${tail ? ": " + tail : ""}` })
    })
  } catch (e) {
    finish({ ok: false, detail: (e as Error).message })
  }
}

export function runCommandTask(task: ScheduledTask, now: number): void {
  if (!task.command) {
    logger.warn({ task: task.name }, "command task has no command, skipping")
    return
  }
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : 10_000
  const failThreshold = task.failThreshold && task.failThreshold > 0 ? task.failThreshold : 2
  // Wave rollout (2026-09-20): opt-in per task, so one task can be measured
  // for a day before the rest follow. Default stays on the old sync path.
  if (task.asyncRunner) {
    runCommandAsync(task.command, timeoutMs, ({ ok, detail }) => {
      // load() at completion time, not at start: the map is a module-level
      // cache shared by every task in this process, so this hands over
      // whatever other tasks wrote while this one was still running. It is
      // NOT a re-read from disk -- load() returns the cached object once it
      // exists. That is what we want here; a disk re-read would drop their
      // in-memory updates.
      // Date.now() (not the scheduler's `now`) because on this path the
      // judging happens when the command finished, which may be minutes later.
      finishCommandTask(task, load(), ok, detail, failThreshold, Date.now())
    })
    return
  }
  const map = load()
  const { ok, detail } = runCommand(task.command, timeoutMs)
  finishCommandTask(task, map, ok, detail, failThreshold, now)
}

// Everything after the command has run: health bookkeeping, the task_runs
// row and the Telegram alert. Shared by BOTH paths on purpose -- the whole
// point of the wave is that only the running changes, not the judging.
// Note that appendTaskRun still fires AFTER the command completes, so the
// slot-to-fired distance stays the measurable quantity it was before.
function finishCommandTask(
  task: ScheduledTask,
  map: HealthMap,
  ok: boolean,
  detail: string,
  failThreshold: number,
  now: number,
): void {
  const { next, action } = evaluateCommandResult(map[task.name], ok, failThreshold, now)
  map[task.name] = next
  persist()
  try { appendTaskRun(task.name, task.agent || "system") } catch { /* non-fatal */ }
  logger.info({ task: task.name, ok, detail, fails: next.fails, action }, "command task ran")

  if (action === "none") return
  const ownerChat = resolveOwnerChatId()
  if (!TELEGRAM_BOT_TOKEN || !ownerChat) {
    logger.warn({ task: task.name }, "command task alert suppressed: missing token, or no owner chat (ALLOWED_CHAT_ID unset/placeholder and no paired channel)")
    return
  }
  const label = task.description || task.name
  const text = action === "alert"
    ? `\u{1F534} Hiba: ${label} nem v\u00e1laszol (${next.fails}. egym\u00e1s ut\u00e1ni hiba). R\u00e9szlet: ${detail}`
    : `\u{1F7E2} Helyre\u00e1llt: ${label} ism\u00e9t OK.`
  sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, text)
    .then(() => logger.info({ task: task.name, action }, "command task alert sent"))
    .catch((err) => logger.warn({ err, task: task.name }, "command task alert send failed"))
}
