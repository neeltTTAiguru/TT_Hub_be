import test from 'node:test'
import assert from 'node:assert/strict'
import { HUBSPOT_DEAL_INSTRUCTIONS, chatWithHubSpotDeals } from '../src/services/hubspotDeals.js'

test('instructions keep the executive HubSpot deal-pipeline framing', () => {
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /HubSpot deal pipeline assistant/)
  // The authoritative pipeline rule must survive any edit to the instructions.
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /Qualified Lead only after a demo has been scheduled/)
})

test('tool-use guardrails cover every logged failure mode that caused retry loops', () => {
  // Missing required argument: query_crm_data was invoked without "sql".
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /query_crm_data requires a non-empty "sql" argument/)
  // Unsupported SQL: DISTINCT must be steered to GROUP BY.
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /does not support DISTINCT/)
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /use GROUP BY instead/)
  // search_properties rejected 6 keywords (max 5).
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /at most 5 keywords per call/)
  // Cost: prefer an aggregate count over paginating every record.
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /prefer a single aggregate query \(COUNT with GROUP BY\)/)
  // Do not loop on an identical failing call.
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /Never repeat the identical failing call/)
})

test('chatWithHubSpotDeals forwards the exported instructions to Hermes', async () => {
  const originalUrl = process.env.HERMES_API_URL
  const originalKey = process.env.HERMES_API_KEY
  process.env.HERMES_API_URL = 'http://10.124.0.2:8642'
  process.env.HERMES_API_KEY = 'test-key'
  delete process.env.HUBSPOT_HERMES_API_URL

  let capturedInstructions
  let capturedUrl
  const originalFetch = global.fetch
  global.fetch = async (url, options) => {
    capturedUrl = String(url)
    capturedInstructions = JSON.parse(options.body).messages?.[0]?.content
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  try {
    await chatWithHubSpotDeals([{ role: 'user', content: 'how many deals are closed won?' }], {
      // Skip the GBrain round-trip so this stays a pure unit test.
      memoryContext: '',
    })
    assert.ok(capturedInstructions, 'expected Hermes to be called with a system message')
    assert.match(capturedInstructions, /does not support DISTINCT/)
    assert.match(capturedInstructions, /at most 5 keywords per call/)
    // Routes to the dedicated lean gateway on :8643, not the default :8642.
    assert.match(capturedUrl, /:8643\/v1\/chat\/completions$/)
  } finally {
    global.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.HERMES_API_URL
    else process.env.HERMES_API_URL = originalUrl
    if (originalKey === undefined) delete process.env.HERMES_API_KEY
    else process.env.HERMES_API_KEY = originalKey
  }
})

test('falls back to the default gateway when the lean gateway is unreachable', async () => {
  const originalUrl = process.env.HERMES_API_URL
  const originalKey = process.env.HERMES_API_KEY
  process.env.HERMES_API_URL = 'http://10.124.0.2:8642'
  process.env.HERMES_API_KEY = 'test-key'
  delete process.env.HUBSPOT_HERMES_API_URL

  const urls = []
  const originalFetch = global.fetch
  global.fetch = async (url) => {
    urls.push(String(url))
    // First call = lean gateway (:8643) refuses the connection; second = default.
    if (String(url).includes(':8643')) {
      throw new TypeError('fetch failed')
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  try {
    const result = await chatWithHubSpotDeals(
      [{ role: 'user', content: 'how many deals are closed won?' }],
      { memoryContext: '' },
    )
    assert.equal(result.message.content, 'ok')
    assert.ok(urls.some((u) => u.includes(':8643')), 'should try the lean gateway first')
    assert.ok(urls.some((u) => u.includes(':8642')), 'should fall back to the default gateway')
  } finally {
    global.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.HERMES_API_URL
    else process.env.HERMES_API_URL = originalUrl
    if (originalKey === undefined) delete process.env.HERMES_API_KEY
    else process.env.HERMES_API_KEY = originalKey
  }
})
