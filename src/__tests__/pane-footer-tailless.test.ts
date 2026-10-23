import { describe, it, expect } from 'vitest'
import {
  detectPaneState,
  detectPermissionMode,
  hasIdleFooter,
  idleFooterIndex,
  detectsModelConsentDialog,
} from '../pane-state.js'

// Regression suite for the 2026-10-23 scheduler outage: ten of the main
// agent's scheduled tasks sat in pending_task_retries from 09:30 to 18:53
// (20 462 "session busy or has pending input, will retry" log lines) while
// the target session was in fact idle at an empty prompt.
//
// Cause: with a background shell running, Claude Code 2.1.309 renders the
// footer as `⏵⏵ bypass permissions on · 1 shell` -- the `·` action list is
// present but the required chrome tail (`ctrl+t` / `↓ to manage` /
// `← for agents`) is NOT. IDLE_FOOTER_RX requires that tail, so the pane
// read footer-less and detectPaneState returned 'unknown'.
//
// Note the already-existing IDLE_BACKGROUND_SHELLS fixture in
// pane-looks-idle.test.ts: the shells footer was anticipated, but only in
// its TAILED form (`· 3 shells · ctrl+t to hide tasks · ↓ to manage`). The
// tail is an enumeration, and this is the build that ran it out.
//
// Fixtures reproduce real `tmux capture-pane -p` bytes (U+2500 ─ separators,
// U+276F ❯ prompt, U+23F5 ⏵ footer chevrons, U+00B7 · footer dot) and were
// derived from live captures by replacing the footer line only.

const SEP = '─'.repeat(80)

const pane = (...lines: string[]) => lines.join('\n')

// (a) The shapes that used to read 'unknown'.
const TAILLESS_ONE_SHELL = pane('', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · 1 shell')
const TAILLESS_THREE_SHELLS = pane('', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · 3 shells')
const TAILLESS_ACCEPT_EDITS = pane('', SEP, '❯ ', SEP, '  ⏵⏵ accept edits on · 1 shell')

// (d) The shapes that were already idle and must stay idle.
const TAILED_SHIFT_TAB = pane('', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)')
const TAILED_FLEETVIEW = pane('', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')
const TAILED_SHELLS = pane('', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · 3 shells · ctrl+t to hide tasks · ↓ to manage')
const FOOTER_DEFAULT = pane('', SEP, '❯ ', SEP, '  ? for shortcuts')

describe('tail-less idle footer (· N shell)', () => {
  it('(a) classifies the tail-less footer as idle', () => {
    expect(detectPaneState(TAILLESS_ONE_SHELL)).toBe('idle')
    expect(detectPaneState(TAILLESS_THREE_SHELLS)).toBe('idle')
    expect(detectPaneState(TAILLESS_ACCEPT_EDITS)).toBe('idle')
  })

  it('(a) reads the permission mode from the same line', () => {
    expect(detectPermissionMode(TAILLESS_ONE_SHELL)).toBe('bypass permissions')
    expect(detectPermissionMode(TAILLESS_ACCEPT_EDITS)).toBe('accept edits')
  })

  it('(d) leaves the already-recognised footers idle', () => {
    for (const p of [TAILED_SHIFT_TAB, TAILED_FLEETVIEW, TAILED_SHELLS, FOOTER_DEFAULT]) {
      expect(detectPaneState(p)).toBe('idle')
    }
  })
})

describe('position is the discriminator, not the tail', () => {
  // (b) The tail-less string is weak enough to appear in prose, so it only
  // counts on the last non-empty line. A pane that merely QUOTES it -- a
  // watchdog report, a log analysis, this very test's description -- has no
  // live footer and must stay unknown.
  it('(b) a quoted tail-less footer in scrollback is not a footer', () => {
    const quoted = pane(
      'Reading the scheduler log:',
      '  ⏵⏵ bypass permissions on · 1 shell',
      'That line was on the footer while the tasks piled up.',
      '',
    )
    expect(hasIdleFooter(quoted)).toBe(false)
    expect(detectPaneState(quoted)).toBe('unknown')
    expect(detectPermissionMode(quoted)).toBe(null)
  })

  // (c) THE REGRESSION THIS SUITE EXISTS FOR, and it failed BEFORE the
  // tail-less shape was ever added: detectPaneState and liveInputBox resolved
  // the footer with Array.findIndex, i.e. TOP-DOWN. A footer-looking line
  // quoted in scrollback won the anchor, the input-box scan then ran above
  // the live box, and a pane holding unsubmitted text read 'idle' -- so the
  // scheduler delivered a prompt that concatenated into someone's draft.
  it('(c) parked text stays typing when a footer-looking line sits in scrollback', () => {
    const parked = pane('', SEP, '❯ unsent draft', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)')
    expect(detectPaneState(parked)).toBe('typing')

    const parkedWithQuote = pane(
      'Earlier in this session the footer read:',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      '',
      SEP,
      '❯ unsent draft',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    )
    expect(detectPaneState(parkedWithQuote)).toBe('typing')
  })

  it('(c) the resolved footer is the LAST matching line, not the first', () => {
    const twoFooters = pane(
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    )
    expect(idleFooterIndex(twoFooters)).toBe(4)
  })
})

describe('the widened footer does not swallow the dialogs', () => {
  // The model-consent dialog's hint line is also `<words> · <words>`. It must
  // NOT read as a footer, or the consent handler would stop answering it and
  // sessions would silently switch model. The space-terminated word before
  // `on` is what keeps `Enter to confirm · Esc to cancel` out.
  const CONSENT = pane(
    '  Fable 5 now uses usage credits',
    '    1. Continue with Fable 5',
    '  ❯ 2. Switch to Sonnet 5 and continue',
    '  Enter to confirm · Esc to cancel',
  )
  it('leaves the model-consent dialog detectable', () => {
    expect(hasIdleFooter(CONSENT)).toBe(false)
    expect(detectsModelConsentDialog(CONSENT)).toBe(true)
  })
})

describe('the two readers of the tail-less shape cannot drift', () => {
  // The strict shape lived in TWO literals (IDLE_FOOTER_RX and
  // detectPermissionMode's inline copy) and they diverged: the footer fix
  // alone would have left the dashboard showing NO permission mode for every
  // pane with a background shell -- the field that exists to surface an
  // ask-first mode. The tail-less shape is single-sourced; this test is what
  // keeps the pair honest if someone extends one side.
  it('a recognised footer always yields a permission mode', () => {
    for (const p of [
      TAILLESS_ONE_SHELL, TAILLESS_THREE_SHELLS, TAILLESS_ACCEPT_EDITS,
      TAILED_SHIFT_TAB, TAILED_FLEETVIEW, TAILED_SHELLS, FOOTER_DEFAULT,
    ]) {
      expect(hasIdleFooter(p)).toBe(true)
      expect(detectPermissionMode(p)).not.toBe(null)
    }
  })
})
