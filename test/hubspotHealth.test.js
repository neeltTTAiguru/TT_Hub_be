import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyProbeContent,
  refreshHubSpotHealth,
  getHubSpotHealth,
  assertHubSpotToolsAvailable,
  assertResponseIsLive,
  createSentinelGate,
  HUBSPOT_UNAVAILABLE_SENTINEL,
} from '../src/services/hubspotHealth.js'
import { HUBSPOT_DEAL_INSTRUCTIONS } from '../src/services/hubspotDeals.js'

function withMockedGateway(content, run) {
  const originalFetch = global.fetch
  const originalUrl = process.env.HERMES_API_URL
  const originalKey = process.env.HERMES_API_KEY
  process.env.HERMES_API_URL = 'https://hermes.example.test'
  process.env.HERMES_API_KEY = 'test-key'
  global.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
  return (async () => {
    try {
      return await run()
    } finally {
      global.fetch = originalFetch
      process.env.HERMES_API_URL = originalUrl
      process.env.HERMES_API_KEY = originalKey
    }
  })()
}

test('a hub id in the probe reply means the HubSpot tools are loaded', () => {
  const result = classifyProbeContent('50827856')
  assert.equal(result.status, 'ok')
  assert.equal(result.hubId, '50827856')
})

test('the sentinel means the gateway silently dropped the HubSpot MCP', () => {
  const result = classifyProbeContent(HUBSPOT_UNAVAILABLE_SENTINEL)
  assert.equal(result.status, 'down')
})

test('an unreadable probe reply stays unknown so a working assistant is never blocked', () => {
  // 'unknown' must NOT be treated as down: a timeout or a confused reply proves
  // nothing about the tools, and blocking on it would cause more outages than it
  // prevents.
  assert.equal(classifyProbeContent('').status, 'unknown')
  assert.equal(classifyProbeContent('I am not sure what you mean.').status, 'unknown')
})

test('a confirmed drop makes the deal assistant refuse instead of answering stale', async () => {
  await withMockedGateway(HUBSPOT_UNAVAILABLE_SENTINEL, async () => {
    await refreshHubSpotHealth()
    assert.equal(getHubSpotHealth().status, 'down')
    assert.throws(() => assertHubSpotToolsAvailable(), (error) => {
      assert.equal(error.statusCode, 503)
      assert.equal(error.code, 'HUBSPOT_TOOLS_UNAVAILABLE')
      return true
    })
  })

  // ...and recovers on its own once the gateway has its tools back.
  await withMockedGateway('50827856', async () => {
    await refreshHubSpotHealth()
    assert.equal(getHubSpotHealth().status, 'ok')
    assert.doesNotThrow(() => assertHubSpotToolsAvailable())
  })
})

test('the sentinel is turned into an error even if it arrives mid-conversation', () => {
  assert.doesNotThrow(() => assertResponseIsLive('Closed Won, MSA signed 2026-08-17.'))
  assert.throws(() => assertResponseIsLive(HUBSPOT_UNAVAILABLE_SENTINEL), /HubSpot connection is down/)
})

test('instructions forbid answering deal questions from conversation history', () => {
  // This is the rule that would have prevented the 2026-08-17 incident, where the
  // agent reported a five-day-stale "Quote Sent" for a deal already Closed Won.
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /Never restate a deal fact from an earlier message/)
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, /obtained in THIS turn/)
  assert.match(HUBSPOT_DEAL_INSTRUCTIONS, new RegExp(HUBSPOT_UNAVAILABLE_SENTINEL))
})

test('the stream gate passes a normal answer through unchanged and in order', () => {
  const written = []
  const gate = createSentinelGate((text) => written.push(text))
  const chunks = ['Palo Pinto County ', 'is Closed Won, ', 'MSA signed 2026-08-17.']
  chunks.forEach(gate.emit)
  gate.flush()
  assert.equal(written.join(''), chunks.join(''))
})

test('the stream gate releases a reply shorter than the sentinel at flush', () => {
  const written = []
  const gate = createSentinelGate((text) => written.push(text))
  gate.emit('4 deals.')
  assert.deepEqual(written, [], 'held while it could still turn out to be the sentinel')
  gate.flush()
  assert.equal(written.join(''), '4 deals.')
})

test('the stream gate never leaks the sentinel into the chat bubble', () => {
  const written = []
  const gate = createSentinelGate((text) => written.push(text))
  HUBSPOT_UNAVAILABLE_SENTINEL.match(/.{1,5}/g).forEach(gate.emit)
  assert.deepEqual(written, [])
  // The route calls assertResponseIsLive (which throws) before flush, so a held
  // sentinel is never released; flush only ever runs on a clean reply.
  assert.throws(() => assertResponseIsLive(HUBSPOT_UNAVAILABLE_SENTINEL))
})
