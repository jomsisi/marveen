// FORK (v1.49.1 merge): the scheduled-task registry hash ignores backup copies kept inside a task dir.
// The fleet keeps `SKILL.md.<date>-ELOTTE-*` copies next to a task; before this, every new copy flipped the
// task to hash-mismatch and the runner stopped firing it. Pinned on the REAL hash function over a real dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scheduledTaskHashFromFiles, isTaskDirBackupName } from '../web/scheduled-tasks-io.js'

let dir: string
const SKILL = Buffer.from('---\nname: t\ndescription: d\n---\n\nprompt\n')
const CONFIG = Buffer.from('{"schedule":"0 8 * * *","agent":"boss","type":"task"}\n')
const hash = () => {
  const h = scheduledTaskHashFromFiles(dir, readFileSync(join(dir, 'SKILL.md')), readFileSync(join(dir, 'task-config.json')))
  expect(h.contentHash).toBeTruthy()
  return h.contentHash
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'schedhash-'))
  writeFileSync(join(dir, 'SKILL.md'), SKILL)
  writeFileSync(join(dir, 'task-config.json'), CONFIG)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const BACKUPS = [
  'SKILL.md.bak-0906', 'SKILL.md.boss-20261003-ELOTTE-x', 'SKILL.md.20260927-ELOTTE-y', 'task-config.json.bak',
  'task-config.json.20261001-ELOTTE-z', 'notes.bak', 'notes.bak-1', 'run-ELOTTE-fix.sh', 'a.orig', 'a.rej', 'SKILL.md~',
]

describe('task dir hash and backup copies', () => {
  it.each(BACKUPS)('(a) adding or changing %s does not change the hash', (name) => {
    const before = hash()
    writeFileSync(join(dir, name), 'one')
    expect(hash()).toBe(before)
    writeFileSync(join(dir, name), 'two, changed')
    expect(hash()).toBe(before)
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'references', name), 'nested')
    expect(hash()).toBe(before)
  })

  it('(a) many backup copies do not count toward the 500-entry bound', () => {
    const before = hash()
    for (let i = 0; i < 600; i++) writeFileSync(join(dir, `SKILL.md.2026${i}-ELOTTE-x`), 'b')
    expect(hash()).toBe(before)
  })

  it('(b) one byte of SKILL.md or task-config.json DOES change the hash', () => {
    const before = hash()
    writeFileSync(join(dir, 'SKILL.md'), Buffer.concat([SKILL, Buffer.from('x')]))
    const afterSkill = hash()
    expect(afterSkill).not.toBe(before)
    writeFileSync(join(dir, 'SKILL.md'), SKILL)
    expect(hash()).toBe(before)
    writeFileSync(join(dir, 'task-config.json'), Buffer.concat([CONFIG, Buffer.from(' ')]))
    expect(hash()).not.toBe(before)
  })

  it('(c) adding or changing references/*.md or a script DOES change the hash', () => {
    const before = hash()
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'references', 'valami.md'), 'a')
    const withRef = hash()
    expect(withRef).not.toBe(before)
    writeFileSync(join(dir, 'references', 'valami.md'), 'b')
    expect(hash()).not.toBe(withRef)
    const withRefB = hash()
    writeFileSync(join(dir, 'helper.sh'), 'echo hi')
    expect(hash()).not.toBe(withRefB)
  })

  it('names that merely contain a pattern are not backups', () => {
    for (const n of ['SKILL.md', 'task-config.json', 'references', 'bakery.md', 'orig.sh', 'rejected.md', 'ELOTTE.md', 'mybak.py']) {
      expect(isTaskDirBackupName(n), n).toBe(false)
    }
    for (const n of BACKUPS) expect(isTaskDirBackupName(n), n).toBe(true)
  })
})
