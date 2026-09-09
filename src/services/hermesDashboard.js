import crypto from 'crypto'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { resolveActor } from '../middleware/auth.js'

/**
 * Serves the Hermes desktop UI through the Hub's own origin.
 *
 * Two problems force this shape.
 *
 * 1. The Hermes SPA does not survive being framed cross-origin: it renders and
 *    then ignores every click, because its UI library walks parent windows to
 *    position popovers and that throws SecurityError across an origin boundary.
 *    So the dashboard has to be reachable at the Hub's own hostname, which means
 *    proxying it rather than pointing an iframe at the droplet.
 *
 * 2. An iframe cannot present a bearer token. Its document request and every
 *    /assets/*.js it pulls are plain browser requests with no Authorization
 *    header, so `requireAuth` cannot gate them. A short-lived signed cookie can,
 *    and is minted by POST /hermes-session, which IS bearer-authenticated.
 *
 * The dashboard is a terminal, a file browser and the API-keys page on the
 * droplet. Everything here fails CLOSED: no secret, no target, or no allowlist
 * entry means the proxy refuses rather than opens.
 */

const COOKIE_NAME = 'hermes_dashboard'
const SESSION_TTL_MS = Number(process.env.HERMES_DASHBOARD_SESSION_TTL_MS || 8 * 60 * 60 * 1000)

// Paths the Hermes SPA owns. It has no base-path support -- its bundle asks for
// /assets and /api absolutely -- so these are matched at the root.
const HERMES_PREFIXES = [
  '/assets', '/fonts', '/fonts-terminal', '/api',
  '/analytics', '/channels', '/chat', '/config', '/cron', '/docs', '/env',
  '/files', '/logs', '/mcp', '/models', '/pairing', '/plugins', '/profiles',
  '/sessions', '/skills', '/system', '/webhooks',
]

// The one place Hermes' path set overlaps the Hub API's. Checked before the
// prefix match so an existing route is never shadowed by the proxy.
const RESERVED = ['/api/seo-content']

function splitEnvList(value = '') {
  return String(value).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
}

function getConfig() {
  return {
    target: String(process.env.HERMES_DASHBOARD_URL || '').replace(/\/$/, ''),
    secret: String(process.env.HERMES_DASHBOARD_SESSION_SECRET || ''),
    allowed: splitEnvList(process.env.HERMES_DASHBOARD_ALLOWED_EMAILS),
  }
}

export function isHermesDashboardConfigured() {
  const { target, secret } = getConfig()
  return Boolean(target && secret)
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

function mintToken(email, secret) {
  const payload = Buffer.from(
    JSON.stringify({ email, exp: Date.now() + SESSION_TTL_MS }),
  ).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

function readToken(token, secret) {
  const [payload, signature] = String(token || '').split('.')
  if (!payload || !signature) return null
  const expected = sign(payload, secret)
  // Length check first: timingSafeEqual throws on a length mismatch, and an
  // attacker controls the length.
  if (signature.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!claims?.exp || claims.exp < Date.now()) return null
    return claims
  } catch {
    return null
  }
}

// Deliberately not pulling in cookie-parser for one cookie on one route.
function readCookie(req, name) {
  const header = req.headers?.cookie || ''
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim())
    }
  }
  return ''
}

function isAllowed(email, allowed) {
  // Fails closed. An empty allowlist does NOT mean "everyone" here -- unlike
  // ALLOWED_EMAIL_DOMAINS, which guards ordinary API calls. This grants a shell
  // on the droplet, so it has to be granted explicitly.
  if (!allowed.length) return false
  if (!email) return false
  const normalised = email.toLowerCase()
  return allowed.includes(normalised) || allowed.includes(`@${normalised.split('@')[1] || ''}`)
}

/**
 * POST /hermes-session -- mint the cookie the iframe will travel on.
 * Must be mounted behind requireAuth: this is where the bearer token is checked.
 */
export async function createHermesSession(req, res) {
  const { target, secret, allowed } = getConfig()
  if (!target || !secret) {
    return res.status(503).json({
      message: 'The Hermes dashboard is not configured on this backend.',
    })
  }

  const email = await resolveActor(req)
  if (!isAllowed(email, allowed)) {
    return res.status(403).json({
      message: `${email || 'This account'} is not approved for the Hermes dashboard.`,
    })
  }

  res.cookie?.(COOKIE_NAME, mintToken(email, secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  })
  return res.json({ ok: true, email, expiresInMs: SESSION_TTL_MS })
}

export function destroyHermesSession(_req, res) {
  res.clearCookie?.(COOKIE_NAME, { path: '/' })
  return res.json({ ok: true })
}

function wantsHermes(pathname) {
  if (RESERVED.some((reserved) => pathname === reserved || pathname.startsWith(`${reserved}/`))) {
    return false
  }
  return HERMES_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * The proxy itself, plus the cookie gate in front of it. Mount BEFORE the global
 * requireAuth: these requests carry a cookie, never a bearer.
 */
export function createHermesDashboardMiddleware() {
  const { target } = getConfig()
  const proxy = target
    ? createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        xfwd: true,
        // The dashboard is a single-page app behind its own router; leave paths
        // untouched so /chat reaches Hermes as /chat.
        pathRewrite: undefined,
      })
    : null

  const middleware = (req, res, next) => {
    if (!wantsHermes(req.path)) return next()

    const { secret, allowed } = getConfig()
    // Unconfigured means invisible, not 503. These paths belong to Hermes, and
    // when Hermes is not wired up they are simply not routes on this service --
    // falling through leaves the 404 they returned before this middleware
    // existed. Answering 503 also made DigitalOcean's edge rewrite them into a
    // 504 gateway page, which reads like an outage rather than a feature that
    // is switched off.
    if (!proxy || !secret) return next()

    const claims = readToken(readCookie(req, COOKIE_NAME), secret)
    if (!claims || !isAllowed(claims.email, allowed)) {
      // 401 rather than a redirect: the caller is an iframe, and a redirect to a
      // login page would just render the login inside the Orchestrator tab.
      return res.status(401).json({ message: 'No Hermes dashboard session.' })
    }
    return proxy(req, res, next)
  }

  middleware.proxy = proxy
  middleware.wantsHermes = wantsHermes
  return middleware
}

/**
 * Websocket upgrades bypass Express entirely, so the cookie gate has to be
 * repeated here. The chat terminal is a PTY over a websocket -- without this the
 * chat connects and immediately drops.
 */
export function attachHermesDashboardUpgrade(server, middleware) {
  if (!middleware?.proxy) return
  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0]
    if (!wantsHermes(pathname)) return

    const { secret, allowed } = getConfig()
    const claims = readToken(readCookie(req, COOKIE_NAME), secret)
    if (!claims || !isAllowed(claims.email, allowed)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    middleware.proxy.upgrade(req, socket, head)
  })
}
