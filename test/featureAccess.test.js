import test from 'node:test'
import assert from 'node:assert/strict'
import { hasFullAccess, requireFeatureAccess, requireFullAccess } from '../src/middleware/featureAccess.js'

const CLAIM = 'https://trustedtechnology.ai/email'

/** Enough of an Express trio to see which branch was taken. */
function harness(path, payload, method = 'GET') {
  const req = { path, method, headers: {}, auth: { payload } }
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
  const previous = process.env.FULL_ACCESS_EMAILS
  const previousDomain = process.env.AUTH0_DOMAIN
  // Unset so the /userinfo fallback short-circuits instead of hitting network.
  delete process.env.AUTH0_DOMAIN
  if (value === undefined) delete process.env.FULL_ACCESS_EMAILS
  else process.env.FULL_ACCESS_EMAILS = value
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.FULL_ACCESS_EMAILS
    else process.env.FULL_ACCESS_EMAILS = previous
    if (previousDomain !== undefined) process.env.AUTH0_DOMAIN = previousDomain
  }
}

test('the map and Brevo are open to everyone who is signed in', async () => {
  await withEnv('neel@trustedtechnology.ai', async () => {
    for (const path of [
      '/le-agencies',
      '/le-agencies/geojson',
      '/le-agencies/NY0303000/briefing',
      '/crm-deals/geojson',
      '/brevo/lists',
    ]) {
      const { req, res, next, out } = harness(path, { sub: 'auth0|9', [CLAIM]: 'someone@trustedtechnology.ai' })
      await requireFeatureAccess(req, res, next)
      assert.equal(out.passed, true, `${path} should be open`)
      assert.equal(out.status, 0)
    }
  })
})

test('everything else is refused to an account that is not on the list', async () => {
  await withEnv('neel@trustedtechnology.ai', async () => {
    for (const path of ['/agents', '/company-files', '/users', '/admin', '/content-operations', '/rfp-opportunities']) {
      const { req, res, next, out } = harness(path, { sub: 'auth0|9', [CLAIM]: 'someone@trustedtechnology.ai' })
      await requireFeatureAccess(req, res, next)
      assert.equal(out.passed, false, `${path} should be refused`)
      assert.equal(out.status, 403)
      assert.match(out.body.message, /someone@trustedtechnology\.ai/)
    }
  })
})

test('a full-access account reaches everything', async () => {
  await withEnv('neel@trustedtechnology.ai,todd.hodnett@trustedtechnology.ai', async () => {
    for (const email of ['Neel@TrustedTechnology.ai', 'Todd.Hodnett@trustedtechnology.ai']) {
      const { req, res, next, out } = harness('/admin/users', { sub: 'auth0|1', [CLAIM]: email })
      await requireFeatureAccess(req, res, next)
      assert.equal(out.passed, true, `${email} should be let through`)
    }
  })
})

test('a prefix that merely starts the same is not the allowed one', async () => {
  await withEnv('neel@trustedtechnology.ai', async () => {
    const { req, res, next, out } = harness('/brevo-admin', { sub: 'auth0|9', [CLAIM]: 'someone@trustedtechnology.ai' })
    await requireFeatureAccess(req, res, next)
    assert.equal(out.passed, false)
    assert.equal(out.status, 403)
  })
})

test('an unidentifiable account is refused, and told why', async () => {
  await withEnv('neel@trustedtechnology.ai', async () => {
    const { req, res, next, out } = harness('/agents', { sub: 'auth0|9' })
    await requireFeatureAccess(req, res, next)
    assert.equal(out.passed, false)
    assert.equal(out.status, 403)
    assert.match(out.body.message, /could not be identified/)
  })
})

test('preflights are not the place to enforce this', async () => {
  await withEnv('neel@trustedtechnology.ai', async () => {
    const { req, res, next, out } = harness('/agents', undefined, 'OPTIONS')
    await requireFeatureAccess(req, res, next)
    assert.equal(out.passed, true)
  })
})

test('an unset allowlist falls back to Neel rather than to everyone', async () => {
  await withEnv(undefined, async () => {
    assert.equal(hasFullAccess('neel@trustedtechnology.ai'), true)
    assert.equal(hasFullAccess('someone@trustedtechnology.ai'), false)
    assert.equal(hasFullAccess(''), false)
  })
})

test('starting, stopping and downloading a research run is for the full-access pair only', async () => {
  await withEnv('neel@trustedtechnology.ai,todd.hodnett@trustedtechnology.ai', async () => {
    const restricted = harness('/research-run/start', { sub: 'auth0|9', [CLAIM]: 'someone@trustedtechnology.ai' }, 'POST')
    await requireFullAccess(restricted.req, restricted.res, restricted.next)
    assert.equal(restricted.out.passed, false)
    assert.equal(restricted.out.status, 403)
    assert.match(restricted.out.body.message, /can view research results but cannot start runs or download/)

    for (const email of ['neel@trustedtechnology.ai', 'Todd.Hodnett@trustedtechnology.ai']) {
      const { req, res, next, out } = harness('/research-run/start', { sub: 'auth0|1', [CLAIM]: email }, 'POST')
      await requireFullAccess(req, res, next)
      assert.equal(out.passed, true, `${email} should be let through`)
    }

    const nobody = harness('/research-run/start', { sub: 'auth0|9' }, 'POST')
    await requireFullAccess(nobody.req, nobody.res, nobody.next)
    assert.equal(nobody.out.status, 403)
    assert.match(nobody.out.body.message, /could not be identified/)

    const preflight = harness('/research-run/start', undefined, 'OPTIONS')
    await requireFullAccess(preflight.req, preflight.res, preflight.next)
    assert.equal(preflight.out.passed, true)
  })
})
