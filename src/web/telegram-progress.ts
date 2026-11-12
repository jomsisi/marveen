// Clearing the Telegram "✍️ Dolgozom rajta…" progress placeholder from the
// server side, for answers that never pass through the Telegram `reply` tool.
//
// WHY THIS EXISTS (michel's finding, 2026-11-12, card stop-hook-hang-valasz-dupla-reply).
// Two mechanisms disagreed about what counts as "the user got an answer":
//   - the voice-reply directive (voice-directive.ts) tells the agent to answer a
//     voice message ONLY with a POST to /api/voice/tts, explicitly forbidding a
//     text reply;
//   - the placeholder bookkeeping only ever hears about the Telegram `reply`
//     TOOL (PostToolUse -> telegram_progress_reply_clear.py), so after a
//     successful voice send the pending placeholder is still on file.
// The Stop hook (telegram_progress_clear.py) then reads that leftover as "this
// turn ended without answering the user", blocks the stop and orders a reply --
// so the owner got the voice message AND a text message for one question.
//
// The delivery point is the only place that knows, first-hand, that an answer
// really reached the chat, so the bookkeeping is updated here, with the same
// semantics the PostToolUse hook uses: drop every pending entry for that chat
// and delete the placeholder message(s).
//
// FAIL-CLOSED: nothing is cleared unless the send is CONFIRMED delivered. A
// failed or rejected send leaves the placeholder in place, so the Stop hook
// still nudges, and the user still gets an answer -- the direction of a wrong
// guess has to stay "the owner is answered twice", never "silently never".
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'

type PendingEntry = { chat_id?: string | number; message_id?: number; transcript_path?: string }

// Overridable like the hooks' own TELEGRAM_API_BASE, so a test can point this
// at a local stub and never touch the real Bot API.
function telegramApiBase(): string {
  return (process.env['TELEGRAM_API_BASE'] ?? 'https://api.telegram.org').replace(/\/+$/, '')
}

// The channel plugin's .env holds the bot token for THIS state dir (per-agent
// bots exist, so the global token is not a substitute).
function readBotToken(stateDir: string): string | null {
  try {
    for (const line of readFileSync(join(stateDir, '.env'), 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('TELEGRAM_BOT_TOKEN=')) {
        return trimmed.slice('TELEGRAM_BOT_TOKEN='.length).trim() || null
      }
    }
  } catch { /* unreadable .env -> no token */ }
  return null
}

async function deleteMessage(token: string, chatId: string | number, messageId: number): Promise<void> {
  await fetch(`${telegramApiBase()}/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    signal: AbortSignal.timeout(TOOL_TIMEOUTS['telegram']),
  })
}

/**
 * Drop the pending progress placeholders of `chatId` after an answer was
 * delivered to that chat by a non-`reply` route (today: a synthesized voice
 * message). Returns how many pending entries were dropped.
 *
 * `delivered` is the measured result of the send, not the intent to send: with
 * `delivered: false` this is a no-op (see FAIL-CLOSED above).
 *
 * Never throws: placeholder bookkeeping is an afterthought of the delivery, and
 * must not turn a successful send into an error for the caller.
 */
export async function clearPlaceholdersAfterVoiceDelivery(opts: {
  delivered: boolean
  stateDir: string
  chatId: string
}): Promise<number> {
  const { delivered, stateDir, chatId } = opts
  if (!delivered) return 0
  const pdir = join(stateDir, 'progress')
  if (!existsSync(pdir)) return 0

  let dropped = 0
  let token: string | null | undefined
  try {
    // One file per session (<session_id>.json); this route does not know the
    // session, so every pending file in the dir is checked for this chat.
    for (const name of readdirSync(pdir).filter((f) => f.endsWith('.json'))) {
      const path = join(pdir, name)
      let pending: PendingEntry[]
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
        if (!Array.isArray(parsed)) continue
        pending = parsed as PendingEntry[]
      } catch { continue }

      const keep = pending.filter((p) => String(p.chat_id) !== chatId)
      const drop = pending.filter((p) => String(p.chat_id) === chatId)
      if (drop.length === 0) continue

      if (token === undefined) token = readBotToken(stateDir)
      if (token) {
        for (const p of drop) {
          if (typeof p.message_id !== 'number') continue
          try {
            await deleteMessage(token, p.chat_id ?? chatId, p.message_id)
          } catch (err) {
            // A placeholder that cannot be deleted (already gone, API down) is
            // cosmetic; the bookkeeping below still has to happen, otherwise the
            // Stop hook would demand a second answer for an answered turn.
            logger.warn({ err, chatId }, 'telegram-progress: placeholder delete failed')
          }
        }
      }

      try {
        if (keep.length > 0) {
          // tmp+rename: the watchdog reads these files on its own 60s timer.
          const tmp = `${path}.tmp-${process.pid}`
          writeFileSync(tmp, JSON.stringify(keep))
          renameSync(tmp, path)
        } else {
          unlinkSync(path)
        }
        dropped += drop.length
      } catch (err) {
        logger.warn({ err, path }, 'telegram-progress: pending file update failed')
      }
    }
  } catch (err) {
    logger.warn({ err, stateDir }, 'telegram-progress: placeholder clear failed')
  }
  return dropped
}
