const REQUEST_TIMEOUT_MS = Number(process.env.WORDPRESS_REQUEST_TIMEOUT_MS || 30000)

function configuration() {
  const siteUrl = String(process.env.WORDPRESS_URL || '').trim().replace(/\/$/, '')
  const username = String(process.env.WORDPRESS_USERNAME || '').trim()
  const applicationPassword = String(process.env.WORDPRESS_APPLICATION_PASSWORD || '').trim()
  const apiBase = siteUrl.endsWith('/wp-json/wp/v2') ? siteUrl : `${siteUrl}/wp-json/wp/v2`
  return { siteUrl, apiBase, username, applicationPassword }
}

export function getWordPressSiteUrl() {
  return configuration().siteUrl
}

export function getWordPressEditorUrl(postId) {
  const id = String(postId || '').trim()
  if (!/^\d+$/.test(id) || !configuration().siteUrl) return ''
  return `${configuration().siteUrl}/wp-admin/post.php?post=${encodeURIComponent(id)}&action=edit`
}

export function isWordPressConfigured() {
  const config = configuration()
  return Boolean(config.siteUrl && config.username && config.applicationPassword)
}

async function wordpressRequest(path, options = {}) {
  const config = configuration()
  if (!isWordPressConfigured()) {
    throw Object.assign(new Error('WordPress credentials are not configured.'), { statusCode: 503 })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Basic ${Buffer.from(`${config.username}:${config.applicationPassword}`).toString('base64')}`)
  headers.set('Accept', 'application/json')
  if (options.body && !(options.body instanceof FormData) && !(options.body instanceof Uint8Array)) {
    headers.set('Content-Type', 'application/json')
  }

  try {
    const response = await fetch(`${config.apiBase}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
      body: options.body && headers.get('Content-Type') === 'application/json'
        ? JSON.stringify(options.body)
        : options.body,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(payload?.message || `WordPress request failed with HTTP ${response.status}.`)
      error.statusCode = response.status === 401 || response.status === 403 ? 502 : response.status
      throw error
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('WordPress request timed out.'), { statusCode: 504 })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function verifyWordPressAuthentication() {
  const user = await wordpressRequest('/users/me?context=edit')
  return { connected: true, user: { id: user.id, name: user.name, slug: user.slug } }
}

export function listWordPressPosts({ page = 1, perPage = 10, status = 'any' } = {}) {
  const query = new URLSearchParams({
    context: 'edit',
    page: String(page),
    per_page: String(Math.min(100, Math.max(1, perPage))),
    status,
  })
  return wordpressRequest(`/posts?${query}`)
}

function listWordPressItems(type, { page = 1, perPage = 10, status = 'any', search = '' } = {}) {
  const query = new URLSearchParams({
    context: 'edit',
    page: String(page),
    per_page: String(Math.min(100, Math.max(1, perPage))),
    status,
  })
  if (search) query.set('search', search)
  return wordpressRequest(`/${type === 'page' ? 'pages' : 'posts'}?${query}`)
}

export async function listWordPressDrafts({ perPage = 20, search = '' } = {}) {
  const [posts, pages] = await Promise.all([
    listWordPressItems('post', { status: 'draft', perPage, search }),
    listWordPressItems('page', { status: 'draft', perPage, search }),
  ])
  return [
    ...posts.map((item) => ({ ...item, type: 'post' })),
    ...pages.map((item) => ({ ...item, type: 'page' })),
  ].sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')))
}

export function listWordPressPublishedPosts({ perPage = 12, status = 'publish' } = {}) {
  const query = new URLSearchParams({
    context: 'edit',
    status,
    per_page: String(Math.min(50, Math.max(1, perPage))),
    orderby: 'date',
    order: 'desc',
    _embed: 'wp:featuredmedia,wp:term',
  })
  return wordpressRequest(`/posts?${query}`)
}

export async function getWordPressDraft(postId) {
  const id = String(postId || '').trim()
  if (!/^\d+$/.test(id)) {
    throw Object.assign(new Error('Provide a valid numeric WordPress draft ID.'), { statusCode: 400 })
  }

  let item
  let type = 'post'
  try {
    item = await wordpressRequest(`/posts/${encodeURIComponent(id)}?context=edit`)
  } catch (error) {
    if (error?.statusCode !== 404) throw error
    item = await wordpressRequest(`/pages/${encodeURIComponent(id)}?context=edit`)
    type = 'page'
  }

  if (item.status !== 'draft') {
    throw Object.assign(new Error(`WordPress ${type} ${id} is not a draft and was not changed.`), { statusCode: 400 })
  }

  return { ...item, type }
}

export async function getWordPressPost(postId) {
  const id = String(postId || '').trim()
  if (!/^\d+$/.test(id)) {
    throw Object.assign(new Error('Provide a valid numeric WordPress post ID.'), { statusCode: 400 })
  }
  const item = await wordpressRequest(`/posts/${encodeURIComponent(id)}?context=edit`)
  return { ...item, type: 'post' }
}

export function createWordPressDraft(post) {
  return wordpressRequest('/posts', {
    method: 'POST',
    body: { ...post, status: 'draft' },
  })
}

export function createWordPressPageDraft(page) {
  return wordpressRequest('/pages', {
    method: 'POST',
    body: { ...page, status: 'draft' },
  })
}

export async function findWordPressDraft({ slug, title }) {
  const query = new URLSearchParams({
    context: 'edit',
    status: 'draft',
    per_page: '100',
    search: String(title || ''),
  })
  const posts = await wordpressRequest(`/posts?${query}`)
  const normalizedTitle = String(title || '').trim().toLowerCase()
  return posts.find((post) => (
    post.slug === slug || String(post.title?.rendered || '').trim().toLowerCase() === normalizedTitle
  )) || null
}

export function updateWordPressPost(postId, changes, { allowPublish = false } = {}) {
  const status = changes?.status
  if (status === 'publish' && !allowPublish) {
    throw Object.assign(new Error('Explicit approval is required before publishing a WordPress post.'), { statusCode: 400 })
  }
  return wordpressRequest(`/posts/${encodeURIComponent(postId)}`, {
    method: 'POST',
    body: changes,
  })
}

export function updateWordPressDraft(item, changes) {
  if (!item || item.status !== 'draft' || !['post', 'page'].includes(item.type)) {
    throw Object.assign(new Error('Only a verified WordPress draft can be updated.'), { statusCode: 400 })
  }
  return wordpressRequest(`/${item.type === 'page' ? 'pages' : 'posts'}/${encodeURIComponent(item.id)}`, {
    method: 'POST',
    body: { ...changes, status: 'draft' },
  })
}

export function trashWordPressDraft(item) {
  if (!item || item.status !== 'draft' || !['post', 'page'].includes(item.type)) {
    throw Object.assign(new Error('Only a verified WordPress draft can be moved to trash.'), { statusCode: 400 })
  }
  return wordpressRequest(`/${item.type === 'page' ? 'pages' : 'posts'}/${encodeURIComponent(item.id)}`, {
    method: 'DELETE',
  })
}

// SiteGround's SG Optimizer (plugin "Speed Optimizer") purges a post's own URL on
// publish, but leaves archive/listing pages like /blog/ cached until they expire.
// Re-saving the Blog page fires SG's purge-on-save for that URL, so a freshly
// published post appears on the blog index immediately. Best-effort: a purge
// failure must never fail the publish itself.
export async function purgeBlogListingCache() {
  try {
    const pages = await wordpressRequest('/pages?slug=blog&context=edit&per_page=1')
    const blog = Array.isArray(pages) ? pages[0] : null
    if (!blog?.id) return { purged: false, reason: 'no Blog page found' }
    const title = blog?.title?.raw ?? 'Blog'
    await wordpressRequest(`/pages/${encodeURIComponent(blog.id)}`, {
      method: 'POST',
      body: { title },
    })
    return { purged: true, pageId: blog.id }
  } catch (error) {
    return { purged: false, reason: error?.message || 'purge failed' }
  }
}

export async function uploadWordPressMedia({ bytes, fileName, contentType, altText = '' }) {
  const media = await wordpressRequest('/media', {
    method: 'POST',
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${String(fileName || 'upload').replace(/["\r\n]/g, '')}"`,
    },
    body: bytes,
  })
  return altText
    ? wordpressRequest(`/media/${encodeURIComponent(media.id)}`, {
        method: 'POST',
        body: { alt_text: altText },
      })
    : media
}

export function listWordPressCategories() {
  return wordpressRequest('/categories?per_page=100&context=edit')
}

export function listWordPressTags() {
  return wordpressRequest('/tags?per_page=100&context=edit')
}
