import test from 'node:test'
import assert from 'node:assert/strict'
import { requireAllowedDomain, resolveActor } from '../src/middleware/auth.js'

const CLAIM = 'https://trustedtechnology.ai/email'

/** Enough of an Express pair to see which branch was taken. */
function harness(payload, headers = {}) {
  const req = { auth: { payload }, headers }
  const out = { status: 0, body: null, passed: false }
  const res = {
    status(code) {
      out.status = code
      return res
    },
    json(body) {
      out.body = body
      return res
    },
  }
  return { req, res, next: () => { out.passed = true }, out }
}

const withEnv = async (value, run) => {
  const previous = process.env.ALLOWED_EMAIL_DOMAINS
  const previousDomain = process.env.AUTH0_DOMAIN
  // Unset so the /userinfo fallback short-circuits instead of hitting network.
  delete process.env.AUTH0_DOMAIN
  if (value === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS
  else process.env.ALLOWED_EMAIL_DOMAINS = value
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS
    else process.env.ALLOWED_EMAIL_DOMAINS = previous
    if (previousDomain !== undefined) process.env.AUTH0_DOMAIN = previousDomain
  }
}

test('does nothing when no domains are configured', async () => {
  await withEnv(undefined, async () => {
    const { req, res, next, out } = harness({ sub: 'auth0|1' })
    await requireAllowedDomain(req, res, next)
    assert.equal(out.passed, true)
    assert.equal(out.status, 0)
  })
})

test('lets an approved domain through and carries the email forward', async () => {
  await withEnv('trustedtechnology.ai', async () => {
    const { req, res, next, out } = harness({ sub: 'auth0|1', [CLAIM]: 'Kyle@TrustedTechnology.ai' })
    await requireAllowedDomain(req, res, next)
    assert.equal(out.passed, true)
    assert.equal(req.authEmail, 'kyle@trustedtechnology.ai')
  })
})

test('refuses an outside domain and names it', async () => {
  await withEnv('trustedtechnology.ai', async () => {
    const { req, res, next, out } = harness({ sub: 'auth0|2', [CLAIM]: 'someone@gmail.com' })
    await requireAllowedDomain(req, res, next)
    assert.equal(out.passed, false)
    assert.equal(out.status, 403)
    assert.match(out.body.message, /gmail\.com/)
  })
})

test('accepts any of several configured domains', async () => {
  await withEnv('trustedtechnology.ai, cindergrid.com', async () => {
    const { req, res, next, out } = harness({ sub: 'auth0|3', [CLAIM]: 'joe@cindergrid.com' })
    await requireAllowedDomain(req, res, next)
    assert.equal(out.passed, true)
  })
})

test('falls back to the standard email claim when the namespaced one is absent', async () => {
  await withEnv('trustedtechnology.ai', async () => {
    const { req, res, next, out } = harness({ sub: 'auth0|4', email: 'neel@trustedtechnology.ai' })
    await requireAllowedDomain(req, res, next)
    assert.equal(out.passed, true)
  })
})

// The lockout case worth being deliberate about: a token with nothing to
// identify the caller is refused, not waved through.
test('refuses a token carrying no email at all', async () => {
  await withEnv('trustedtechnology.ai', async () => {
    const { req, res, next, out } = harness({ sub: 'auth0|5' })
    await requireAllowedDomain(req, res, next)
    assert.equal(out.passed, false)
    assert.equal(out.status, 403)
    assert.match(out.body.message, /could not be identified/)
  })
})

// The stamps on the map - "qualified by", "logged by" - are the reason the
// email matters outside the domain check.
test('resolveActor prefers the email the domain check already found', async () => {
  const req = { auth: { payload: { sub: 'auth0|9' } }, headers: {}, authEmail: 'kyle@trustedtechnology.ai' }
  assert.equal(await resolveActor(req), 'kyle@trustedtechnology.ai')
})

test('resolveActor reads the namespaced claim when the check did not run', async () => {
  const req = { auth: { payload: { sub: 'auth0|9', [CLAIM]: 'Neel@TrustedTechnology.ai' } }, headers: {} }
  assert.equal(await resolveActor(req), 'neel@trustedtechnology.ai')
})

test('resolveActor falls back to the subject rather than to nothing', async () => {
  const previous = process.env.AUTH0_DOMAIN
  delete process.env.AUTH0_DOMAIN
  try {
    const req = { auth: { payload: { sub: 'auth0|9' } }, headers: {} }
    assert.equal(await resolveActor(req), 'auth0|9')
  } finally {
    if (previous !== undefined) process.env.AUTH0_DOMAIN = previous
  }
})
