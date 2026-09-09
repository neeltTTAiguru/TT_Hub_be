import { auth as auth0Auth } from 'express-oauth2-jwt-bearer'

let cachedAuthConfig = null

/**
 * Where the caller's email is expected to be found on an access token.
 *
 * It is not there by default. Auth0 puts `email` in the ID token, which the
 * browser keeps and the API never sees; an access token minted for a custom API
 * audience carries `sub` and scopes and nothing that identifies a person. So
 * this claim only exists if a Login Action deliberately writes it - see
 * docs/auth0/restrict-to-trusted-domains.js - and everything below is built to
 * cope with it being absent.
 */
const EMAIL_CLAIM = process.env.AUTH0_EMAIL_CLAIM?.trim() || 'https://trustedtechnology.ai/email'

function splitEnvList(value = '') {
  return String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

const emailFromPayload = (payload) => {
  const raw = payload?.[EMAIL_CLAIM] ?? payload?.email
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

/**
 * A short-lived token -> email cache.
 *
 * Without one, a domain check that falls back to /userinfo turns every single
 * API call into a second round trip to Auth0 - on a page that fires a dozen
 * requests, against a tenant with a rate limit. Keyed by the token itself, so
 * it cannot outlive the credential it describes, and swept when it gets big
 * rather than on a timer.
 */
const USERINFO_TTL_MS = Number(process.env.AUTH0_USERINFO_TTL_MS || 10 * 60 * 1000)
const USERINFO_MAX = 500
const userInfoCache = new Map()

const bearerFrom = (req) => {
  const header = req.headers?.authorization || ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
}

/**
 * Ask Auth0 who this token belongs to.
 *
 * The fallback for a tenant whose Action is not deployed yet. Returns '' on any
 * failure; the caller decides what an unknown email means, which differs
 * between "who is the admin" and "may this person in at all".
 */
export async function resolveEmailFromUserInfo(req) {
  const auth0Domain = process.env.AUTH0_DOMAIN?.trim()
  const token = bearerFrom(req)
  if (!auth0Domain || !token) return ''

  const cached = userInfoCache.get(token)
  if (cached && cached.expires > Date.now()) return cached.email

  try {
    const response = await fetch(`https://${auth0Domain}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return ''
    const profile = await response.json()
    const email = typeof profile?.email === 'string' ? profile.email.trim().toLowerCase() : ''
    if (userInfoCache.size >= USERINFO_MAX) userInfoCache.clear()
    userInfoCache.set(token, { email, expires: Date.now() + USERINFO_TTL_MS })
    return email
  } catch {
    return ''
  }
}

function getAuthConfig() {
  const auth0Domain = process.env.AUTH0_DOMAIN?.trim() || ''
  const auth0Audience = process.env.AUTH0_AUDIENCE?.trim() || ''

  if (!auth0Domain || !auth0Audience) {
    return null
  }

  if (
    cachedAuthConfig &&
    cachedAuthConfig.domain === auth0Domain &&
    cachedAuthConfig.audience === auth0Audience
  ) {
    return cachedAuthConfig.middleware
  }

  const middleware = auth0Auth({
    issuerBaseURL: `https://${auth0Domain}`,
    audience: auth0Audience,
    tokenSigningAlg: 'RS256',
  })

  cachedAuthConfig = {
    domain: auth0Domain,
    audience: auth0Audience,
    middleware,
  }

  return middleware
}

/**
 * Second gate: the caller's email must sit on a domain we trust.
 *
 * The real gate is the Auth0 Action, which refuses the login before a token is
 * ever minted. This is the same rule enforced where it cannot be talked around
 * - an Action can be switched off in a dashboard, and any token already issued
 * before that happens stays valid until it expires.
 *
 * Opt-in: with ALLOWED_EMAIL_DOMAINS unset this does nothing at all. Turning a
 * lockout on by default, in a service whose access tokens usually carry no
 * email, would log the entire company out on deploy.
 */
export async function requireAllowedDomain(req, res, next) {
  const allowed = splitEnvList(process.env.ALLOWED_EMAIL_DOMAINS)
  if (!allowed.length) return next()

  let email = emailFromPayload(req.auth?.payload)
  if (!email) email = await resolveEmailFromUserInfo(req)

  // Deliberately a refusal, not a pass. An unverifiable email is the exact
  // shape of the thing this is meant to stop, and the message names the cause
  // so it is not mistaken for "wrong domain" by whoever has to debug it.
  if (!email) {
    return res.status(403).json({
      message:
        'Your account could not be identified. Sign out and back in; if it persists, the Auth0 login action may not be adding the email claim.',
    })
  }

  const domain = email.split('@')[1] || ''
  if (!allowed.includes(domain)) {
    return res.status(403).json({
      message: `${email} is not on an approved domain. Ask an administrator to add ${domain || 'it'}, or sign in with your work account.`,
    })
  }

  // Carried so the request handlers - and the "qualified by" stamps they write
  // - get a person's email rather than an auth0|... subject.
  req.authEmail = email
  return next()
}

export function requireAuth(req, res, next) {
  if (req.method === 'OPTIONS') {
    return next()
  }

  const authMiddleware = getAuthConfig()

  if (!authMiddleware) {
    return res.status(503).json({
      message: 'Auth0 API protection is not configured. Set AUTH0_DOMAIN and AUTH0_AUDIENCE on the backend.',
    })
  }

  // The signature check first, always. The domain rule reads claims, and claims
  // from an unverified token are just a string somebody sent us.
  return authMiddleware(req, res, (error) => {
    if (error) return next(error)
    return requireAllowedDomain(req, res, next).catch(next)
  })
}

/**
 * Who to record as having done something.
 *
 * Every "qualified by" and "logged by" stamp on the map wants a person, and an
 * access token minted for a custom API audience carries only `auth0|68f3...`.
 * That is not a name anyone reading a six-month-old call log can act on, so
 * this pays a cached /userinfo call to turn it into an email when the token has
 * no email claim of its own.
 *
 * Falls back to the subject rather than to '': an opaque id still answers "was
 * this me or someone else", which an empty string does not.
 */
export async function resolveActor(req) {
  const payload = req.auth?.payload
  const known = req.authEmail || emailFromPayload(payload)
  if (known) return known
  const looked = await resolveEmailFromUserInfo(req)
  return looked || (typeof payload?.sub === 'string' ? payload.sub : '')
}

export function getAuthenticatedUser(req) {
  const payload = req.auth?.payload
  const userId = typeof payload?.sub === 'string' ? payload.sub.trim() : ''

  if (!userId) {
    const error = new Error('Authenticated user is missing a subject claim.')
    error.statusCode = 401
    throw error
  }

  return {
    id: userId,
    // Whatever the domain check already resolved, so a second lookup is not
    // paid for the same request.
    email: req.authEmail || emailFromPayload(payload),
    payload,
  }
}
