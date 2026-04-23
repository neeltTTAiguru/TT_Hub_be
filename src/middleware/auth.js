import { auth as auth0Auth } from 'express-oauth2-jwt-bearer'

let cachedAuthConfig = null

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

  return authMiddleware(req, res, next)
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
    email: typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '',
    payload,
  }
}
