import test from 'node:test'
import assert from 'node:assert/strict'
import { getHermesRetryDelayMs, isHermesRateLimit } from '../src/services/hermesChat.js'

test('detects Hermes rate limits even when the gateway returns a non-429 status', () => {
  assert.equal(isHermesRateLimit(500, 'API call failed: Rate limit reached for tokens per min (TPM).'), true)
  assert.equal(isHermesRateLimit(429, ''), true)
  assert.equal(isHermesRateLimit(500, 'ordinary upstream failure'), false)
  assert.equal(isHermesRateLimit(200, 'API call failed after 3 retries: Rate limit reached for GPT.'), true)
})

test('uses the provider retry delay with a small safety buffer', () => {
  assert.equal(getHermesRetryDelayMs('Please try again in 6.578s.', 0), 7078)
  assert.equal(getHermesRetryDelayMs('Please try again in 250ms.', 0), 750)
})
