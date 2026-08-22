import test from 'node:test'
import assert from 'node:assert/strict'
import { findReusableDraftForRun } from '../src/services/contentOperations.js'

// Draft reuse exists so a restarted pipeline updates its own post instead of piling up
// duplicates. Matching on title/slug alone matched ANY draft on the site, so a second
// article producing the same slug overwrote the first run's post and adopted its id.
// Both runs then pointed at one post, and opening the older one showed the newer article.

const NEVER_CLAIMED = async () => false

test('a run updates its own draft and never searches by title', async () => {
  let searched = false
  const draft = await findReusableDraftForRun(
    { runId: 'run-a', wordpressPublication: { postId: 1200 } },
    { slug: 'digital-evidence', title: 'Digital Evidence Management' },
    {
      getWordPressDraft: async (id) => ({ id: Number(id), status: 'draft' }),
      findWordPressDraft: async () => { searched = true; return { id: 4242 } },
      isClaimedByAnotherRun: NEVER_CLAIMED,
    },
  )
  assert.equal(draft.id, 1200)
  assert.equal(searched, false, 'must not fall back to a title search when it owns a post')
})

test('a run whose own post is no longer a draft leaves every draft alone', async () => {
  const draft = await findReusableDraftForRun(
    { runId: 'run-a', wordpressPublication: { postId: 1200 } },
    { slug: 'digital-evidence', title: 'Digital Evidence Management' },
    {
      // Published or trashed: getWordPressDraft rejects.
      getWordPressDraft: async () => { throw new Error('not a draft') },
      findWordPressDraft: async () => ({ id: 4242 }),
      isClaimedByAnotherRun: NEVER_CLAIMED,
    },
  )
  assert.equal(draft, null)
})

test('a new run refuses a same-titled draft that another run already owns', async () => {
  const draft = await findReusableDraftForRun(
    { runId: 'run-b', wordpressPublication: { postId: null } },
    { slug: 'digital-evidence', title: 'Digital Evidence Management' },
    {
      getWordPressDraft: async () => null,
      findWordPressDraft: async () => ({ id: 1200, status: 'draft' }),
      isClaimedByAnotherRun: async (runId, postId) => runId === 'run-b' && postId === 1200,
    },
  )
  assert.equal(draft, null, 'overwriting another run\'s post is what showed the wrong article')
})

test('a new run does reuse an unclaimed same-titled draft', async () => {
  const draft = await findReusableDraftForRun(
    { runId: 'run-b', wordpressPublication: { postId: null } },
    { slug: 'digital-evidence', title: 'Digital Evidence Management' },
    {
      getWordPressDraft: async () => null,
      findWordPressDraft: async () => ({ id: 1200, status: 'draft' }),
      isClaimedByAnotherRun: NEVER_CLAIMED,
    },
  )
  assert.equal(draft.id, 1200)
})
