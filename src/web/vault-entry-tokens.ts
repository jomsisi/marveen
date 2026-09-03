// One-time, short-lived credential-entry tokens.
//
// Flow (option "A"): an agent mints a token bound to a fixed Vault id, hands the
// resulting link to the end user, who opens it and submits a credential form.
// The form writes STRAIGHT into the Vault server-side -- the agent never sees
// the plaintext. Each token is single-use and expires quickly. The Vault id is
// FIXED at mint time so a leaked link can only write the one intended secret,
// never overwrite an unrelated one.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

const STORE_PATH = join(PROJECT_ROOT, 'store', 'vault-entry-tokens.json')
const DEFAULT_TTL_SECONDS = 900 // 15 minutes
const MAX_TTL_SECONDS = 3600
const MIN_TTL_SECONDS = 60

export interface EntryToken {
  token: string
  vaultId: string
  label: string
  siteHint: string
  loginUrl: string
  createdBy: string
  createdAt: number   // epoch ms
  expiresAt: number   // epoch ms
  usedAt: number | null
}

interface TokenStore {
  tokens: EntryToken[]
}

function read(): TokenStore {
  if (!existsSync(STORE_PATH)) return { tokens: [] }
  try { return JSON.parse(readFileSync(STORE_PATH, 'utf-8')) }
  catch { return { tokens: [] } }
}

function write(store: TokenStore): void {
  atomicWriteFileSync(STORE_PATH, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

// Drop tokens that expired AND used tokens older than a day, so the file cannot
// grow without bound. Called opportunistically on every mint/validate.
function sweep(store: TokenStore, now: number): TokenStore {
  const dayAgo = now - 24 * 3600 * 1000
  store.tokens = store.tokens.filter(t => {
    if (t.usedAt) return t.usedAt > dayAgo
    return t.expiresAt > dayAgo
  })
  return store
}

export function mintEntryToken(opts: {
  vaultId: string
  label: string
  siteHint: string
  loginUrl?: string
  createdBy: string
  ttlSeconds?: number
  now: number
}): EntryToken {
  const ttl = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, opts.ttlSeconds ?? DEFAULT_TTL_SECONDS))
  const entry: EntryToken = {
    token: randomBytes(32).toString('base64url'),
    vaultId: opts.vaultId,
    label: opts.label,
    siteHint: opts.siteHint,
    loginUrl: opts.loginUrl ?? '',
    createdBy: opts.createdBy,
    createdAt: opts.now,
    expiresAt: opts.now + ttl * 1000,
    usedAt: null,
  }
  const store = sweep(read(), opts.now)
  store.tokens.push(entry)
  write(store)
  return entry
}

// Returns the token entry only if it exists, is unused, and is not expired.
export function getValidToken(token: string, now: number): EntryToken | null {
  if (!token) return null
  const store = read()
  const entry = store.tokens.find(t => t.token === token)
  if (!entry) return null
  if (entry.usedAt) return null
  if (entry.expiresAt <= now) return null
  return entry
}

// Marks the token used. Returns false if it was already used/expired/missing
// (guards against a double submit racing two writes to the same secret).
export function consumeToken(token: string, now: number): boolean {
  const store = read()
  const entry = store.tokens.find(t => t.token === token)
  if (!entry || entry.usedAt || entry.expiresAt <= now) return false
  entry.usedAt = now
  write(sweep(store, now))
  return true
}
