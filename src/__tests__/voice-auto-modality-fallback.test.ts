import { describe, it, expect } from 'vitest'
import { shouldSpeakInAuto } from '../web/voice-directive.js'

// The 2026-09-14 regression, and the test that was missing for three months.
//
// Two paths transcribe an inbound voice message. The hook reads the audio
// marker off the channel tag; message-router transcribes server-side and
// REWRITES the tag, stripping attachment_kind and attachment_file_id. While the
// router's STT was unreliable the hook did both jobs and voice replies worked.
// Once the router became dependable it consumed the hook's input, and `auto`
// mode answered voice with text -- silently, with no error anywhere.
//
// Nothing caught it because every test drove the two halves separately: the
// transcription was green, the directive was green, and their ORDER was never
// exercised. This file tests the order: the decision must still say "speak"
// when the envelope has ALREADY been rewritten.
describe('shouldSpeakInAuto', () => {
  it('speaks when the envelope still carries the audio marker', () => {
    expect(shouldSpeakInAuto(true, null)).toBe(true)
  })

  it('speaks when the envelope was rewritten but the turn was recorded as voice', () => {
    // THE regression: no marker left on the tag, and the only surviving
    // evidence is what the router wrote down before it stripped the tag.
    expect(shouldSpeakInAuto(false, 'voice')).toBe(true)
  })

  it('stays in text when the last inbound turn was text', () => {
    // A text follow-up clears the flag in the router, so this is the common
    // case right after a voice exchange -- it must NOT keep speaking.
    expect(shouldSpeakInAuto(false, 'text')).toBe(false)
  })

  it('stays in text with no envelope marker and nothing recorded', () => {
    // Cold start, expired entry (10 min TTL), or a restarted process.
    expect(shouldSpeakInAuto(false, null)).toBe(false)
  })

  it('a recorded text turn does not veto a live audio envelope', () => {
    // The envelope is first-hand evidence about THIS message; the store is a
    // memory of the previous one. If they disagree, the envelope wins.
    expect(shouldSpeakInAuto(true, 'text')).toBe(true)
  })
})
