import { resolveActor } from './auth.js'

/**
 * Who gets the whole hub, and who gets two things.
 *
 * Signing in is not the same as being allowed everywhere. The Auth0 Action and
 * ALLOWED_EMAIL_DOMAINS answer "may this person in at all"; this answers "and
 * then what may they touch". Everybody who is not on the full-access list gets
 * the Agency Map and the Brevo email agent, and a 403 everywhere else.
 *
 * Kept in the environment rather than in the User collection on purpose. This
 * is the gate, and a gate that opens by editing a document in the database it
 * is protecting is not one - /users can already create and edit User records.
 *
 * Defaults to Neel alone: a backend that comes up without the variable set
 * should fail towards less access, not more.
 */
const DEFAULT_FULL_ACCESS_EMAILS = 'neel@trustedtechnology.ai'

/**
 * The API surface a restricted account may reach, as path prefixes on the app.
 *
 * `/le-agencies` and `/crm-deals` are what the Agency Map page draws on - the
 * agency layer, the traveller and his chat, briefings, SDR forms, call logs,
 * research runs and the deal pins all hang off those two routers. `/brevo` is
 * the email builder's lists, senders and campaigns.
 *
 * Deliberately a list of routers, not of individual endpoints: a new endpoint
 * added to one of the two features keeps working, and a new router is closed
 * until someone puts it here on purpose.
 */
export const RESTRICTED_ACCESS_PREFIXES = ['/le-agencies', '/crm-deals', '/brevo']

function splitEnvList(value = '') {
  return String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

export function fullAccessEmails() {
  const configured = splitEnvList(process.env.FULL_ACCESS_EMAILS)
  return configured.length ? configured : splitEnvList(DEFAULT_FULL_ACCESS_EMAILS)
}

export function hasFullAccess(email = '') {
  const normalised = String(email).trim().toLowerCase()
  if (!normalised) return false
  return fullAccessEmails().includes(normalised)
}

/**
 * The caller's email, or '' when it cannot be established.
 *
 * resolveActor falls back to the Auth0 subject (`auth0|68f3...`) so call logs
 * still say who did something. An opaque id is useless to an allowlist and
 * must never be mistaken for a match, so anything without an @ is discarded.
 */
export async function resolveActorEmail(req) {
  const actor = await resolveActor(req)
  return typeof actor === 'string' && actor.includes('@') ? actor.trim().toLowerCase() : ''
}

export function isRestrictedAllowedPath(path = '') {
  return RESTRICTED_ACCESS_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  )
}

/**
 * Second gate, after requireAuth: is this person allowed at this feature?
 *
 * Fails closed. An account whose email cannot be resolved is refused the
 * restricted routers rather than waved through - an unidentifiable caller is
 * the exact shape of what this is meant to stop - and the message names the
 * cause so it is not debugged as "wrong person".
 */
export async function requireFeatureAccess(req, res, next) {
  // requireAuth lets preflights past without ever populating req.auth, so
  // there is nothing here to check and nobody to check it against.
  if (req.method === 'OPTIONS') return next()

  if (isRestrictedAllowedPath(req.path)) return next()

  let email = ''
  try {
    email = await resolveActorEmail(req)
  } catch (error) {
    return next(error)
  }

  if (hasFullAccess(email)) return next()

  if (!email) {
    return res.status(403).json({
      message:
        'Your account could not be identified, so only the Agency Map and the Brevo email agent are available. Sign out and back in; if it persists, the Auth0 login action may not be adding the email claim.',
    })
  }

  return res.status(403).json({
    message: `${email} has access to the Agency Map and the Brevo email agent only. Ask an administrator to widen it.`,
  })
}

/**
 * Third gate, for the handful of things inside a restricted router that a
 * restricted account still must not do.
 *
 * The map is open to everyone who can sign in, but starting a research run
 * spends real money and the spreadsheet is the whole dataset in one file. Those
 * stay with the full-access pair; everybody else gets to watch the run and
 * read its findings on screen. Same fail-closed shape as requireFeatureAccess.
 */
export async function requireFullAccess(req, res, next) {
  if (req.method === 'OPTIONS') return next()

  let email = ''
  try {
    email = await resolveActorEmail(req)
  } catch (error) {
    return next(error)
  }

  if (hasFullAccess(email)) return next()

  return res.status(403).json({
    message: email
      ? `${email} can view research results but cannot start runs or download the data. Ask an administrator to widen it.`
      : 'Your account could not be identified, so research runs and downloads are not available. Sign out and back in.',
  })
}
