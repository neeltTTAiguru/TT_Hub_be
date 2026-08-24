import test from 'node:test'
import assert from 'node:assert/strict'
import { briefFromDraft } from '../src/services/contentPublish.js'

// The publishing metadata below the article's `---` rule is what the WordPress
// draft is built from, so parsing it wrong is what puts the wrong title and slug
// on the blog.

const DRAFT = `# T500 for repossession companies

Repossession work depends on fast decisions and clear records.

## Why documentation matters

Body copy.

---

Meta title: T500 body worn camera for repossession companies
Slug: t500-body-worn-camera-repossession
Meta description: How the T500 documents repossession work end to end.
Category: Field guides
Tags: body worn camera, repossession, evidence
Sources: internal
`

test('reads the meta block into the brief the WordPress draft is built from', () => {
  const brief = briefFromDraft(DRAFT)
  assert.equal(brief.proposedTitle, 'T500 body worn camera for repossession companies')
  assert.equal(brief.slug, 't500-body-worn-camera-repossession')
  assert.equal(brief.metaDescription, 'How the T500 documents repossession work end to end.')
  assert.equal(brief.category, 'Field guides')
  assert.deepEqual(brief.tags, ['body worn camera', 'repossession', 'evidence'])
})

test('falls back to the H1 when the writer left no meta block', () => {
  const brief = briefFromDraft('# T500 for repossession companies\n\nBody copy only.')
  assert.equal(brief.proposedTitle, 'T500 for repossession companies')
  assert.equal(brief.slug, '')
  assert.equal(brief.primaryKeyword, 'T500 for repossession companies')
})

test('derives the primary keyword from the slug when one is declared', () => {
  const brief = briefFromDraft(DRAFT)
  assert.equal(brief.primaryKeyword, 't500 body worn camera repossession')
})
