import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'

// Service-account auth for Google APIs, shared by GA4 and Search Console. One
// credential file (GOOGLE_APPLICATION_CREDENTIALS) signs a JWT per scope; tokens
// are cached per scope because a token minted for analytics.readonly cannot be
// used against the Search Console API and vice versa.

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

let credentialsCache = null
const accessTokenCache = new Map()

// Two ways to supply the key. A file path (GOOGLE_APPLICATION_CREDENTIALS) is
// the local-dev way. A hosted app has no file to point at, so the key's JSON
// can be pasted straight into GOOGLE_SERVICE_ACCOUNT_JSON — raw or base64 —
// as an encrypted env var on the DigitalOcean app. The inline form wins when
// both are set.
function credentialsPath() {
  return String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
}

function inlineCredentials() {
  return String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim()
}

export function isGoogleServiceAccountConfigured() {
  return Boolean(inlineCredentials() || credentialsPath())
}

function parseCredentials(text, source) {
  let raw = text
  // Base64 is the safer paste into an env field: no quotes, no newlines to
  // mangle the private key.
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8')
  const value = JSON.parse(raw)
  if (value.type !== 'service_account' || !value.client_email || !value.private_key) {
    throw new Error(`The Google credential in ${source} is not a valid service-account JSON key.`)
  }
  return value
}

export async function loadGoogleCredentials() {
  const inline = inlineCredentials()
  const path = credentialsPath()
  const key = inline ? `inline:${inline.length}` : path
  if (!key) throw new Error('Google credentials are not configured (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS).')
  if (credentialsCache?.path === key) return credentialsCache.value

  const value = inline
    ? parseCredentials(inline, 'GOOGLE_SERVICE_ACCOUNT_JSON')
    : parseCredentials(await readFile(path, 'utf8'), 'GOOGLE_APPLICATION_CREDENTIALS')

  credentialsCache = { path: key, value }
  return value
}

export async function getGoogleAccessToken(scope) {
  const cached = accessTokenCache.get(scope)
  if (cached?.expiresAt > Date.now() + 60_000) return cached.token

  const credentials = await loadGoogleCredentials()
  const issuedAt = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claim = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
  })).toString('base64url')
  const unsignedToken = `${header}.${claim}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedToken), credentials.private_key)
  const assertion = `${unsignedToken}.${signature.toString('base64url')}`

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })

  if (!response.ok) {
    throw new Error(`Google OAuth token request failed (${response.status}).`)
  }

  const payload = await response.json()
  accessTokenCache.set(scope, {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  })
  return payload.access_token
}
