import test from 'node:test'
import assert from 'node:assert/strict'
import { enforceArticleLength } from '../src/services/contentOperations.js'

// The two verdicts that need no Hermes call: nothing to check, and already in
// range. Both must still leave a length_check stage so the workflow shows the
// check ran, and must never touch the article.

function fakeRun(overrides = {}) {
  const saves = []
  return {
    runId: 'run-len',
    article: Array.from({ length: 1900 }, (_, i) => `w${i}`).join(' '),
    status: 'completed',
    currentStage: 'article_writing',
    stages: [],
    surferGuidelines: { targetWordCount: 1900, terms: [], questions: [] },
    surferOptimization: { seoScoreAfter: 72, targetScore: 90 },
    save: async () => { saves.push(true) },
    markModified: () => {},
    saves,
    ...overrides,
  }
}

test('no Surfer target: records a skipped check and keeps the article', async () => {
  const run = fakeRun({ surferGuidelines: null, surferOptimization: null })
  const article = run.article
  await enforceArticleLength(run)
  assert.equal(run.article, article)
  assert.equal(run.lengthCheck.status, 'unknown')
  assert.equal(run.lengthCheck.corrected, false)
  const stage = run.stages.at(-1)
  assert.equal(stage.stage, 'length_check')
  assert.match(stage.result, /skipped/)
  assert.equal(stage.output, 'skipped')
})

test('in range: passes, annotates the Surfer result, keeps the article', async () => {
  const run = fakeRun()
  const article = run.article
  await enforceArticleLength(run)
  assert.equal(run.article, article)
  assert.equal(run.lengthCheck.ok, true)
  assert.equal(run.lengthCheck.words, 1900)
  assert.deepEqual([run.lengthCheck.min, run.lengthCheck.max], [1615, 2185])
  assert.equal(run.surferOptimization.lengthOk, true)
  assert.equal(run.surferOptimization.wordCount, 1900)
  assert.match(run.stages.at(-1).result, /Length check passed/)
})

test('out of range with no pass budget: reports the failure honestly', async () => {
  const previous = process.env.CONTENT_OPS_LENGTH_MAX_PASSES
  process.env.CONTENT_OPS_LENGTH_MAX_PASSES = '0'
  try {
    const run = fakeRun({ article: Array.from({ length: 3158 }, (_, i) => `w${i}`).join(' '), surferGuidelines: { targetWordCount: 2487 } })
    await enforceArticleLength(run)
    assert.equal(run.lengthCheck.status, 'long')
    assert.equal(run.lengthCheck.ok, false)
    assert.equal(run.surferOptimization.lengthOk, false)
    assert.match(run.stages.at(-1).result, /Length check FAILED/)
    assert.match(run.stages.at(-1).result, /298 words over/)
  } finally {
    if (previous === undefined) delete process.env.CONTENT_OPS_LENGTH_MAX_PASSES
    else process.env.CONTENT_OPS_LENGTH_MAX_PASSES = previous
  }
})
