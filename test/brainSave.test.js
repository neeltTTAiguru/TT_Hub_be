import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSaveRequests, applySaveRequests, createSaveGate, SAVE_TO_BRAIN_POLICY } from '../src/services/brainSave.js'

test('pulls a save block out of a reply and leaves clean prose', () => {
  const { cleaned, requests } = extractSaveRequests(
    'Got it.\n\n<save-to-brain>{"title":"Company has 11 customers","content":"Trusted Technology has 11 customers as of August 2026.","sensitivity":"internal"}</save-to-brain>',
  )
  assert.equal(cleaned, 'Got it.')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].title, 'Company has 11 customers')
  assert.equal(requests[0].sensitivity, 'internal')
})

test('several facts produce several save requests', () => {
  const { requests } = extractSaveRequests(
    '<save-to-brain>{"title":"A","content":"first fact"}</save-to-brain>'
    + '<save-to-brain>{"title":"B","content":"second fact"}</save-to-brain>',
  )
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map((r) => r.title), ['A', 'B'])
})

test('a malformed block is reported, never shown to the user as raw JSON', () => {
  const { cleaned, requests } = extractSaveRequests('Sure.\n<save-to-brain>{not json}</save-to-brain>')
  assert.equal(cleaned, 'Sure.')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].malformed, true)
})

test('a reply with no save block is untouched', () => {
  const text = 'The T500 records for 12 hours.'
  const { cleaned, requests } = extractSaveRequests(text)
  assert.equal(cleaned, text)
  assert.equal(requests.length, 0)
})

test('the streaming gate never emits the raw block, even split across deltas', () => {
  const out = []
  const gate = createSaveGate((delta) => out.push(delta))
  for (const delta of ['Got ', 'it.\n\n<save-', 'to-brain>{"title":"A",', '"content":"b"}</save-to-brain>']) {
    gate.emit(delta)
  }
  gate.flush()
  const streamed = out.join('')
  assert.match(streamed, /Got it\./)
  assert.doesNotMatch(streamed, /save-to-brain/)
  assert.doesNotMatch(streamed, /title/)
})

test('the gate still flushes ordinary trailing text', () => {
  const out = []
  const gate = createSaveGate((delta) => out.push(delta))
  gate.emit('All done.')
  gate.flush()
  assert.equal(out.join(''), 'All done.')
})

test('the policy forbids claiming a save the agent cannot verify', () => {
  assert.match(SAVE_TO_BRAIN_POLICY, /do NOT call put_page/)
  assert.match(SAVE_TO_BRAIN_POLICY, /do not report success or failure/)
})

test('a correction carries the slug it replaces', () => {
  const { requests } = extractSaveRequests(
    '<save-to-brain>{"title":"Company has 12 customers","content":"12 as of Aug 2026.","replaces":"tt-shared/user-approved/company-has-11-customers-ac454386"}</save-to-brain>',
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].replaces, 'tt-shared/user-approved/company-has-11-customers-ac454386')
})

test('a plain save carries no replaces', () => {
  const { requests } = extractSaveRequests('<save-to-brain>{"title":"A","content":"b"}</save-to-brain>')
  assert.equal(requests[0].replaces, '')
})

test('the policy tells the agent how to correct a page instead of duplicating it', () => {
  assert.match(SAVE_TO_BRAIN_POLICY, /replaces/)
  assert.match(SAVE_TO_BRAIN_POLICY, /which is current/)
})

test('a free-form body with newlines, quotes and bullets survives intact', () => {
  const body = [
    'The tone is highly promotional, confident, and sales-forward.',
    '',
    'It reads as:',
    '- authoritative and executive-level',
    "- persuasive and competitive, using phrases like \u201ccomplete, turnkey package\u201d",
    '',
    'It is not neutral or understated.',
  ].join('\n')
  const { requests } = extractSaveRequests(
    `<save-to-brain>\ntitle: RFP response tone for article writing\nsensitivity: internal\n---\n${body}\n</save-to-brain>`,
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].title, 'RFP response tone for article writing')
  // The whole analysis, not a one-line summary of it.
  assert.equal(requests[0].content, body)
  assert.match(requests[0].content, /authoritative and executive-level/)
  assert.match(requests[0].content, /turnkey package/)
})

test('a header-form correction carries the slug it replaces', () => {
  const { requests } = extractSaveRequests(
    '<save-to-brain>\ntitle: RFP response tone\nreplaces: tt-shared/user-approved/rfp-response-tone-7aff0ce0\n---\nUpdated analysis.\n</save-to-brain>',
  )
  assert.equal(requests[0].replaces, 'tt-shared/user-approved/rfp-response-tone-7aff0ce0')
  assert.equal(requests[0].content, 'Updated analysis.')
})

test('the legacy JSON shape still parses', () => {
  const { requests } = extractSaveRequests('<save-to-brain>{"title":"A","content":"b"}</save-to-brain>')
  assert.equal(requests[0].title, 'A')
  assert.equal(requests[0].content, 'b')
})

test('the policy tells the agent to keep the detail, not summarise it away', () => {
  assert.match(SAVE_TO_BRAIN_POLICY, /PRESERVE THE SUBSTANCE/)
  assert.match(SAVE_TO_BRAIN_POLICY, /not a one-line summary/)
})
