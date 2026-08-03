import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWordPressDraft,
  createWordPressPageDraft,
  getWordPressDraft,
  getWordPressPost,
  listWordPressDrafts,
  updateWordPressDraft,
  updateWordPressPost,
  verifyWordPressAuthentication,
} from '../src/services/wordpress.js'

const originalFetch = global.fetch
const originalEnvironment = {
  url: process.env.WORDPRESS_URL,
  username: process.env.WORDPRESS_USERNAME,
  password: process.env.WORDPRESS_APPLICATION_PASSWORD,
}

function configure() {
  process.env.WORDPRESS_URL = 'https://trustedtechnology.ai'
  process.env.WORDPRESS_USERNAME = 'engineer'
  process.env.WORDPRESS_APPLICATION_PASSWORD = 'application-password'
}

test.afterEach(() => {
  global.fetch = originalFetch
  for (const [key, value] of Object.entries({
    WORDPRESS_URL: originalEnvironment.url,
    WORDPRESS_USERNAME: originalEnvironment.username,
    WORDPRESS_APPLICATION_PASSWORD: originalEnvironment.password,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('verifies authentication through users/me without exposing credentials', async () => {
  configure()
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://trustedtechnology.ai/wp-json/wp/v2/users/me?context=edit')
    assert.match(options.headers.get('Authorization'), /^Basic /)
    return new Response(JSON.stringify({ id: 7, name: 'Engineer', slug: 'engineer' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  assert.deepEqual(await verifyWordPressAuthentication(), {
    connected: true,
    user: { id: 7, name: 'Engineer', slug: 'engineer' },
  })
})

test('always forces initial WordPress posts to draft status', async () => {
  configure()
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.status, 'draft')
    return new Response(JSON.stringify({ id: 42, status: 'draft' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const post = await createWordPressDraft({ title: 'Test', status: 'publish' })
  assert.equal(post.status, 'draft')
})

test('rejects publishing without an explicit approval flag', async () => {
  configure()
  assert.throws(
    () => updateWordPressPost(42, { status: 'publish' }),
    /Explicit approval is required/,
  )
})

test('reads and updates only a verified draft while forcing draft status', async () => {
  configure()
  let requestCount = 0
  global.fetch = async (url, options) => {
    requestCount += 1
    if (requestCount === 1) {
      assert.equal(url, 'https://trustedtechnology.ai/wp-json/wp/v2/posts/1113?context=edit')
      return new Response(JSON.stringify({ id: 1113, status: 'draft', type: 'post', title: { raw: 'Draft' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    assert.equal(url, 'https://trustedtechnology.ai/wp-json/wp/v2/posts/1113')
    assert.deepEqual(JSON.parse(options.body), { content: '<p style="color:white">Text</p>', status: 'draft' })
    return new Response(JSON.stringify({ id: 1113, status: 'draft' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const draft = await getWordPressDraft(1113)
  await updateWordPressDraft(draft, { content: '<p style="color:white">Text</p>', status: 'publish' })
  assert.equal(requestCount, 2)
})

test('refuses to edit a published WordPress item', async () => {
  configure()
  global.fetch = async () => new Response(JSON.stringify({ id: 1113, status: 'publish' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  await assert.rejects(() => getWordPressDraft(1113), /is not a draft and was not changed/)
})

test('creates WordPress pages as drafts', async () => {
  configure()
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://trustedtechnology.ai/wp-json/wp/v2/pages')
    assert.deepEqual(JSON.parse(options.body), { title: 'Resources', content: '<p>Draft</p>', status: 'draft' })
    return new Response(JSON.stringify({ id: 77, status: 'draft' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  assert.equal((await createWordPressPageDraft({ title: 'Resources', content: '<p>Draft</p>', status: 'publish' })).status, 'draft')
})

test('lists both draft posts and pages', async () => {
  configure()
  global.fetch = async (url) => {
    const isPage = url.includes('/pages?')
    return new Response(JSON.stringify([{
      id: isPage ? 2 : 1,
      status: 'draft',
      modified: isPage ? '2026-07-31T12:00:00' : '2026-07-30T12:00:00',
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const drafts = await listWordPressDrafts()
  assert.deepEqual(drafts.map(({ id, type }) => ({ id, type })), [
    { id: 2, type: 'page' },
    { id: 1, type: 'post' },
  ])
})

test('reads the canonical article template even after it is published', async () => {
  configure()
  global.fetch = async (url) => {
    assert.equal(url, 'https://trustedtechnology.ai/wp-json/wp/v2/posts/1113?context=edit')
    return new Response(JSON.stringify({ id: 1113, status: 'publish', content: { raw: '<main>Template</main>' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const template = await getWordPressPost(1113)
  assert.equal(template.type, 'post')
  assert.equal(template.content.raw, '<main>Template</main>')
})
