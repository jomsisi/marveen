// Credential-entry links (option "A"): an agent mints a one-time link, the end
// user opens it and submits a login form, and the credential is written STRAIGHT
// into the Vault server-side. The agent never sees the plaintext.
//
//   POST /api/vault/entry-links   (bearer-gated)  -> mint a link
//   GET  /vault-entry/:token      (public, token-gated) -> the form
//   POST /vault-entry/:token      (public, token-gated) -> write to Vault
//
// The public routes live OUTSIDE /api/ so the auth gate (requiresAuth) leaves
// them open; the single-use, short-TTL token is their only key.
import { setSecret } from '../vault.js'
import { mintEntryToken, getValidToken, consumeToken } from '../vault-entry-tokens.js'
import { readBody, json } from '../http-helpers.js'
import { DASHBOARD_PUBLIC_URL, VAULT_ENTRY_BASE_URL } from '../../config.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

function sanitizeVaultId(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

function sendHtml(res: RouteContext['res'], html: string, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

function baseUrl(req: RouteContext['req']): string {
  // Prefer the dedicated entry-link host (the Funnel), then the dashboard public
  // URL, then the request host. See VAULT_ENTRY_BASE_URL in config.ts for why the
  // two are kept separate.
  if (VAULT_ENTRY_BASE_URL) return VAULT_ENTRY_BASE_URL.replace(/\/$/, '')
  if (DASHBOARD_PUBLIC_URL) return DASHBOARD_PUBLIC_URL.replace(/\/$/, '')
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http'
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim()
    || req.headers.host || '127.0.0.1:3420'
  return `${proto}://${host}`
}

function page(body: string, title = 'Belépő megadása'): string {
  return `<!doctype html><html lang="hu"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e7e9ee;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
@media(prefers-color-scheme:light){body{background:#f4f5f7;color:#1c1e22}}
.card{width:100%;max-width:420px;background:#181b21;border:1px solid #262a33;border-radius:14px;padding:26px}
@media(prefers-color-scheme:light){.card{background:#fff;border-color:#e3e5ea}}
h1{font-size:19px;margin:0 0 6px}
p.sub{margin:0 0 20px;color:#9aa0ab;font-size:14px}
label{display:block;font-size:13px;margin:14px 0 5px;color:#b8bec9}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #333947;background:#0f1218;color:inherit;font-size:15px}
@media(prefers-color-scheme:light){input{background:#f7f8fa;border-color:#d3d6dd}}
input:focus{outline:2px solid #4c7dff;border-color:#4c7dff}
button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:9px;background:#4c7dff;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#3d6bf0}
.note{margin-top:16px;font-size:12px;color:#7c828d;text-align:center}
.ok{color:#3ecf8e}.err{color:#ff6b6b}
</style></head><body><div class="card">${body}</div></body></html>`
}

export async function tryHandleVaultEntry(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // --- Mint a link (agent-only; bearer already enforced by the gate) ---------
  if (path === '/api/vault/entry-links' && method === 'POST') {
    let body: any
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { body = {} }
    const site = String(body.site ?? '').trim()
    if (!site) { json(res, { error: 'site is required' }, 400); return true }
    const owner = String(body.owner ?? 'laura').trim() || 'laura'
    const vaultId = sanitizeVaultId(String(body.vaultId ?? `cred-${slug(owner)}-${slug(site)}`))
    if (!vaultId) { json(res, { error: 'could not derive a vault id' }, 400); return true }
    const label = String(body.label ?? `${owner} - ${site}`).slice(0, 120)
    const loginUrl = String(body.loginUrl ?? '').trim().slice(0, 300)
    const ttlSeconds = Number(body.ttlSeconds) || undefined
    const createdBy = ctx.auth?.kind === 'session' ? (ctx.auth.user || 'session') : 'agent'

    const entry = mintEntryToken({ vaultId, label, siteHint: site, loginUrl, createdBy, ttlSeconds, now: Date.now() })
    logger.info({ vaultId, site, expiresAt: entry.expiresAt }, 'vault-entry: link minted')
    json(res, {
      ok: true,
      url: `${baseUrl(req)}/vault-entry/${entry.token}`,
      vaultId,
      expiresAt: entry.expiresAt,
    })
    return true
  }

  // --- The public form + submit ---------------------------------------------
  const m = path.match(/^\/vault-entry\/([A-Za-z0-9_-]+)$/)
  if (!m) return false
  const token = m[1]

  if (method === 'GET') {
    const entry = getValidToken(token, Date.now())
    if (!entry) {
      sendHtml(res, page('<h1>Lejárt vagy érvénytelen link</h1><p class="sub">Ez a beviteli link már nem használható. Kérj egy újat.</p>', 'Lejárt link'), 410)
      return true
    }
    const site = escapeHtml(entry.siteHint)
    const loginUrl = escapeHtml(entry.loginUrl)
    sendHtml(res, page(
      `<h1>Belépő megadása</h1>
<p class="sub">Oldal: <b>${site}</b>. Az adatok titkosítva, közvetlenül a széfbe kerülnek. Az asszisztens a jelszót nem látja.</p>
<form method="POST" action="/vault-entry/${escapeHtml(token)}" autocomplete="off">
<label>Belépési oldal (URL)</label>
<input name="loginUrl" type="url" value="${loginUrl}" placeholder="https://...">
<label>Felhasználónév / email</label>
<input name="username" type="text" required autocomplete="off" autocapitalize="none" spellcheck="false">
<label>Jelszó</label>
<input name="password" type="password" required autocomplete="new-password">
<button type="submit">Mentés a széfbe</button>
</form>
<p class="note">A link egyszer használatos és rövid ideig él.</p>`
    ))
    return true
  }

  if (method === 'POST') {
    const entry = getValidToken(token, Date.now())
    if (!entry) {
      sendHtml(res, page('<h1 class="err">Lejárt vagy érvénytelen link</h1><p class="sub">Kérj egy újat az asszisztenstől.</p>', 'Lejárt link'), 410)
      return true
    }
    const params = new URLSearchParams((await readBody(req)).toString())
    const username = (params.get('username') || '').trim()
    const password = params.get('password') || ''
    const loginUrl = (params.get('loginUrl') || entry.loginUrl || '').trim()
    if (!username || !password) {
      sendHtml(res, page('<h1 class="err">Hiányzó adat</h1><p class="sub">A felhasználónév és a jelszó is kell. Menj vissza és töltsd ki mindkettőt.</p>', 'Hiányzó adat'), 400)
      return true
    }
    // Consume first: if two submits race, only one wins and writes.
    if (!consumeToken(token, Date.now())) {
      sendHtml(res, page('<h1 class="err">A link már felhasználódott</h1>', 'Felhasználva'), 410)
      return true
    }
    setSecret(entry.vaultId, entry.label, JSON.stringify({
      url: loginUrl,
      username,
      password,
      savedAt: new Date().toISOString(),
    }))
    // NEVER log the value -- only that a write happened.
    logger.info({ vaultId: entry.vaultId, site: entry.siteHint }, 'vault-entry: credential saved')
    sendHtml(res, page('<h1 class="ok">Kész, mentve.</h1><p class="sub">A belépő biztonságosan a széfbe került. Ezt az ablakot bezárhatod.</p>', 'Mentve'))
    return true
  }

  return false
}
