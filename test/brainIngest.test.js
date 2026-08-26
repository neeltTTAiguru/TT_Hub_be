import test from 'node:test'
import assert from 'node:assert/strict'
import { saveDocumentSectionMemory } from '../src/services/memoryGateway.js'

function withGbrain(fn) {
  return async () => {
    const original = process.env.GBRAIN_ENABLED
    process.env.GBRAIN_ENABLED = 'true'
    try { await fn() } finally {
      if (original === undefined) delete process.env.GBRAIN_ENABLED
      else process.env.GBRAIN_ENABLED = original
    }
  }
}

test('ingested pages get a stable slug so re-ingesting updates in place', withGbrain(async () => {
  const writes = []
  const args = {
    documentId: 'doc-1',
    documentTitle: 'Fresno RFP Response 2026',
    section: 'T500 warranty terms offered to agencies',
    content: 'Standard agency warranty is 3 years on the T500 and the dock.',
    write: async (slug, markdown) => { writes.push({ slug, markdown }) },
  }
  const first = await saveDocumentSectionMemory(args)
  const second = await saveDocumentSectionMemory(args)
  assert.equal(first.slug, second.slug)
  assert.equal(first.slug, 'tt-shared/docs/fresno-rfp-response-2026/t500-warranty-terms-offered-to-agencies')
  assert.equal(writes.length, 2)
}))

test('ingested pages are company-wide and approved so every agent retrieves them', withGbrain(async () => {
  let markdown = ''
  await saveDocumentSectionMemory({
    documentId: 'doc-1',
    documentTitle: 'RFP Response',
    section: 'Deployment models',
    content: 'On-premise and hosted deployments are both offered.',
    write: async (_slug, written) => { markdown = written },
  })
  assert.match(markdown, /lifecycle: approved/)
  assert.match(markdown, /sensitivity: internal/)
  assert.match(markdown, /approval_method: company-document-ingest/)
  // No allowed_agents -> readable by every agent under the one-brain rule.
  assert.doesNotMatch(markdown, /allowed_agents/)
}))

test('a section that looks like a credential is rejected, not written', withGbrain(async () => {
  let called = false
  await assert.rejects(
    saveDocumentSectionMemory({
      documentId: 'doc-1',
      documentTitle: 'RFP Response',
      section: 'API access',
      content: 'Use api_key=sk_live_abcdefghijklmnop1234 to authenticate.',
      write: async () => { called = true },
    }),
    /credential/,
  )
  assert.equal(called, false)
}))

test('confidential content cannot be ingested through this path', withGbrain(async () => {
  await assert.rejects(
    saveDocumentSectionMemory({
      documentId: 'doc-1',
      documentTitle: 'RFP Response',
      section: 'Pricing',
      content: 'Rate card details.',
      sensitivity: 'confidential',
      write: async () => {},
    }),
    /public or internal/,
  )
}))
