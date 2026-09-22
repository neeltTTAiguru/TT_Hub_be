import test from 'node:test'
import assert from 'node:assert/strict'
import { busyError } from '../src/services/researchRunner.js'

/**
 * 2026-09-22: the two backends collided at 4 AM and the morning recorded
 * "A research run is already going." against Neil as `failed`, with a finish
 * time. He was out of the plan for the rest of the day and got 0 of 20 leads
 * while Troy ran the next hour. A busy traveller has to read as "come back in
 * a minute", everywhere that reads it.
 */
test('a busy traveller is a retryable 409, not a failure', () => {
  const error = busyError()
  assert.equal(error.statusCode, 409)
  assert.equal(error.retryable, true)
  assert.match(error.message, /already going/)
})

test('the morning queues a retryable error again and writes off anything else', async () => {
  const { classifyStartFailure } = await import('../src/services/dailyResearch.js')

  assert.equal(classifyStartFailure(busyError()).status, 'pending')
  assert.equal(classifyStartFailure({ statusCode: 409 }).status, 'pending')
  assert.equal(classifyStartFailure({ retryable: true }).status, 'pending')
  // Queued again means no finish time: an entry that has finished is never
  // looked at again.
  assert.equal(classifyStartFailure(busyError()).finishedAt, null)

  // A real failure still ends the entry.
  const real = classifyStartFailure(new Error('Nothing matches this targeting.'))
  assert.equal(real.status, 'failed')
  assert.ok(real.finishedAt instanceof Date)
  assert.match(real.note, /Nothing matches/)
})
