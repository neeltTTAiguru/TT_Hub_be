import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRejectedRevision, reviseArticleForRun, revertArticleRevision } from '../src/services/contentOperations.js'

// The revision guards all run BEFORE any Hermes/Surfer/WordPress network call, so they
// are safe to unit test without live services. They protect the two ways post-generation
// editing could damage an article: editing a run that is still working, and reverting a
// snapshot that no longer applies.

function fakeRun(overrides = {}) {
  return {
    runId: 'run-1',
    article: 'word '.repeat(400),
    status: 'completed',
    editorChat: [],
    revisions: [],
    stages: [],
    wordpressPublication: { postId: 1222, status: 'draft' },
    save: async () => {},
    markModified: () => {},
    ...overrides,
  }
}

test('refuses an edit with no instruction', async () => {
  await assert.rejects(
    () => reviseArticleForRun(fakeRun(), { instruction: '   ' }),
    /Describe the edit you want made/,
  )
})

test('refuses to edit a run that has no article yet', async () => {
  await assert.rejects(
    () => reviseArticleForRun(fakeRun({ article: '' }), { instruction: 'Focus on employee safety.' }),
    /does not have an article to edit/,
  )
})

test('refuses to edit a run that is still working', async () => {
  await assert.rejects(
    () => reviseArticleForRun(fakeRun({ status: 'running' }), { instruction: 'Focus on employee safety.' }),
    /still working/,
  )
})

test('refuses to revert a revision that is not on the article', async () => {
  await assert.rejects(
    () => revertArticleRevision(fakeRun(), 'missing-revision'),
    /not on this article/,
  )
})

test('refuses to revert the same revision twice', async () => {
  const run = fakeRun({
    revisions: [{ id: 'rev-1', instruction: 'Tone down law enforcement.', article: 'old', revertedAt: '2026-08-22T00:00:00.000Z' }],
  })
  await assert.rejects(() => revertArticleRevision(run, 'rev-1'), /already been reverted/)
})

test('reverting restores the snapshot and discards every later edit', async () => {
  const run = fakeRun({
    article: 'newest version',
    // A live post is left alone unless applyToLive is passed, so this revert touches no network.
    wordpressPublication: { postId: 1222, status: 'publish' },
    revisions: [
      { id: 'rev-1', instruction: 'first', article: 'original version', revertedAt: null },
      { id: 'rev-2', instruction: 'second', article: 'second version', revertedAt: null },
    ],
  })
  await revertArticleRevision(run, 'rev-1')
  assert.equal(run.article, 'original version')
  assert.ok(run.revisions.every((entry) => entry.revertedAt))
  assert.match(run.editorChat.at(-1).content, /live post was NOT changed/)
})

// The score gate: a rewrite that lowers the SurferSEO score is parked, not applied. It is
// only ever promoted through applyRejectedRevision, which is an explicit editor action.

test('refuses to apply a revision that is not waiting to be applied', async () => {
  const run = fakeRun({
    revisions: [{ id: 'rev-1', instruction: 'first', article: 'old', status: 'applied' }],
  })
  await assert.rejects(() => applyRejectedRevision(run, 'rev-1'), /not waiting to be applied/)
})

test('refuses to apply a parked revision while the run is still working', async () => {
  const run = fakeRun({
    status: 'running',
    revisions: [{ id: 'rev-1', instruction: 'first', article: 'old', candidateArticle: 'new', status: 'rejected' }],
  })
  await assert.rejects(() => applyRejectedRevision(run, 'rev-1'), /still working/)
})

test('applying a parked revision promotes the held-back rewrite and records the score drop', async () => {
  const run = fakeRun({
    article: 'the article as it stands',
    // Live post with no confirmation: the promotion must not reach WordPress.
    wordpressPublication: { postId: 1222, status: 'publish' },
    revisions: [{
      id: 'rev-1',
      instruction: 'Tone down law enforcement.',
      article: 'the article as it stands',
      candidateArticle: 'the employee-safety rewrite',
      status: 'rejected',
      seoScoreBefore: 89,
      seoScoreAfter: 66,
    }],
  })
  await applyRejectedRevision(run, 'rev-1')
  assert.equal(run.article, 'the employee-safety rewrite')
  assert.equal(run.revisions[0].status, 'applied')
  assert.equal(run.revisions[0].appliedDespiteScoreDrop, true)
  assert.equal(run.revisions[0].wordpressSynced, false)
  assert.match(run.editorChat.at(-1).content, /89 → 66/)
})

// The title, slug and meta description live on the brief, so they are part of the
// article's state. Undoing or promoting a rewrite has to move them with the prose —
// otherwise the post keeps a headline describing an angle the body no longer has.

test('reverting restores the title along with the article', async () => {
  const run = fakeRun({
    article: 'the EMS rewrite',
    brief: { proposedTitle: 'How the T500 Helps EMS Teams', slug: 't500-ems', metaDescription: 'EMS.' },
    revisions: [{
      id: 'rev-1',
      instruction: 'Rewrite for EMS.',
      article: 'the law enforcement original',
      brief: { proposedTitle: 'How the T500 Helps Law Enforcement', slug: 't500-le', metaDescription: 'LE.' },
      status: 'applied',
      revertedAt: null,
    }],
  })
  await revertArticleRevision(run, 'rev-1')
  assert.equal(run.article, 'the law enforcement original')
  assert.equal(run.brief.proposedTitle, 'How the T500 Helps Law Enforcement')
  assert.equal(run.brief.slug, 't500-le')
})

test('promoting a held-back rewrite restores the title it was written for', async () => {
  const run = fakeRun({
    article: 'the law enforcement original',
    brief: { proposedTitle: 'How the T500 Helps Law Enforcement', slug: 't500-le' },
    revisions: [{
      id: 'rev-1',
      instruction: 'Rewrite for EMS.',
      article: 'the law enforcement original',
      brief: { proposedTitle: 'How the T500 Helps Law Enforcement', slug: 't500-le' },
      candidateArticle: 'the EMS rewrite',
      candidateBrief: { proposedTitle: 'How the T500 Helps EMS Teams', slug: 't500-ems' },
      status: 'rejected',
      seoScoreBefore: 89,
      seoScoreAfter: 66,
    }],
  })
  await applyRejectedRevision(run, 'rev-1')
  assert.equal(run.article, 'the EMS rewrite')
  assert.equal(run.brief.proposedTitle, 'How the T500 Helps EMS Teams')
})

test('a revision snapshot without a brief leaves the current brief alone', async () => {
  // Runs revised before brief snapshots existed must still be revertable.
  const run = fakeRun({
    article: 'newer',
    brief: { proposedTitle: 'Current title' },
    revisions: [{ id: 'rev-1', instruction: 'legacy', article: 'older', status: 'applied', revertedAt: null }],
  })
  await revertArticleRevision(run, 'rev-1')
  assert.equal(run.article, 'older')
  assert.equal(run.brief.proposedTitle, 'Current title')
})

test('reverting a re-targeted revision restores the keyword and its Surfer editor', async () => {
  const run = fakeRun({
    article: 'the EMS rewrite',
    brief: { proposedTitle: 'T500 for EMS', primaryKeyword: 'body worn camera for ems' },
    selectedOpportunity: { primaryKeyword: 'body worn camera for ems' },
    surferEditorId: 999,
    surferEditorUrl: 'https://app.surferseo.com/drafts/999',
    surferGuidelines: { terms: [{ term: 'ems' }] },
    revisions: [{
      id: 'rev-1',
      instruction: 'Re-aim this at EMS.',
      article: 'the law enforcement original',
      brief: { proposedTitle: 'T500 for Law Enforcement', primaryKeyword: 'body worn camera for law enforcement' },
      opportunity: { primaryKeyword: 'body worn camera for law enforcement' },
      surfer: { editorId: 111, editorUrl: 'https://app.surferseo.com/drafts/111', guidelines: { terms: [{ term: 'police' }] } },
      status: 'applied',
      revertedAt: null,
    }],
  })
  await revertArticleRevision(run, 'rev-1')
  assert.equal(run.brief.primaryKeyword, 'body worn camera for law enforcement')
  assert.equal(run.selectedOpportunity.primaryKeyword, 'body worn camera for law enforcement')
  assert.equal(run.surferEditorId, 111)
  assert.deepEqual(run.surferGuidelines, { terms: [{ term: 'police' }] })
})
