import test from 'node:test'
import assert from 'node:assert/strict'
import { readDealsFromHermesDroplet } from '../src/services/hubspotDeals.js'

test('authenticates to the Hermes Droplet deal gateway', async () => {
  const originalFetch = global.fetch
  const originalUrl = process.env.HUBSPOT_DEALS_PROXY_URL
  const originalToken = process.env.HUBSPOT_DEALS_PROXY_TOKEN
  process.env.HUBSPOT_DEALS_PROXY_URL = 'https://hermes.example.test/hubspot-deals'
  process.env.HUBSPOT_DEALS_PROXY_TOKEN = 'shared-test-token'
  let observed
  global.fetch = async (url, options) => {
    observed = { url, authorization: options.headers.Authorization }
    return new Response(JSON.stringify({ summary: { closed_won_deals: 4 }, deals: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const result = await readDealsFromHermesDroplet()
    assert.deepEqual(observed, {
      url: 'https://hermes.example.test/hubspot-deals',
      authorization: 'Bearer shared-test-token',
    })
    assert.equal(result.summary.closed_won_deals, 4)
  } finally {
    global.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.HUBSPOT_DEALS_PROXY_URL
    else process.env.HUBSPOT_DEALS_PROXY_URL = originalUrl
    if (originalToken === undefined) delete process.env.HUBSPOT_DEALS_PROXY_TOKEN
    else process.env.HUBSPOT_DEALS_PROXY_TOKEN = originalToken
  }
})

