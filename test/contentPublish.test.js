import test from 'node:test'
import assert from 'node:assert/strict'
import { publishWordPressPostForRun } from '../src/services/contentOperations.js'

// These guards must run BEFORE any WordPress network call, so they are safe to
// unit test without a live site. They protect the one publish path that crosses
// the allowPublish guardrail.

test('refuses to publish an article that has not been approved', async () => {
  const run = { approval: { article: false }, wordpressPublication: { postId: 1222 }, save: async () => {} }
  await assert.rejects(() => publishWordPressPostForRun(run), /Approve the article before publishing/)
})

test('refuses to publish when no WordPress draft exists yet', async () => {
  const run = { approval: { article: true }, wordpressPublication: null, save: async () => {} }
  await assert.rejects(() => publishWordPressPostForRun(run), /Create the WordPress draft before publishing/)
})

test('is an idempotent no-op when the post is already published', async () => {
  let saved = false
  const run = {
    approval: { article: true },
    wordpressPublication: { postId: 1222, status: 'publish' },
    save: async () => { saved = true },
  }
  const result = await publishWordPressPostForRun(run)
  assert.equal(result, run)
  assert.equal(saved, false) // returned before any mutation/network
})
