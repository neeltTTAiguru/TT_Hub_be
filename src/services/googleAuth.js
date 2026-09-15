import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'

// Service-account auth for Google APIs, shared by GA4 and Search Console. One
// credential file (GOOGLE_APPLICATION_CREDENTIALS) signs a JWT per scope; tokens
// are cached per scope because a token minted for analytics.readonly cannot be
// used against the Search Console API and vice versa.

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

let credentialsCache = null
const accessTokenCache = new Map()

function credentialsPath() {
  return String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
}

export function isGoogleServiceAccountConfigured() {
  return Boolean(credentialsPath())
}

export async function loadGoogleCredentials() {
  const path = credentialsPath()
  if (!path) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is not configured.')
  if (credentialsCache?.path === path) return credentialsCache.value

  const value = JSON.parse(await readFile(path, 'utf8'))
  if (value.type !== 'service_account' || !value.client_email || !value.private_key) {
    throw new Error('The configured Google credential is not a valid service-account JSON file.')
  }

  credentialsCache = { path, value }
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
