// SurferSEO REST client (API v2). Uses a static API-KEY header — no OAuth, no token
// expiry, no browser re-auth (unlike the Surfer MCP, whose 1h OAuth token + Cloudflare-
// guarded refresh made it unusable on a headless server). The backend drives every
// mechanical Surfer step here; Hermes is used only to rewrite the article prose.

const SURFER_BASE = String(process.env.SURFER_API_URL || 'https://app.surferseo.com/api/v2').replace(/\/$/, '')
// A browser-like UA keeps Cloudflare in front of app.surferseo.com from flagging us.
const SURFER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

function surferKey() {
  return String(process.env.SURFER_API_KEY || '').trim()
}

export function isSurferConfigured() {
  return Boolean(surferKey())
}

async function surferFetch(path, { method = 'GET', accept = 'application/json', contentType, body, signal } = {}) {
  const key = surferKey()
  if (!key) throw Object.assign(new Error('Surfer API key is not configured.'), { statusCode: 503 })
  const headers = { 'API-KEY': key, Accept: accept, 'User-Agent': SURFER_UA }
  if (contentType) headers['Content-Type'] = contentType
  let response
  try {
    response = await fetch(`${SURFER_BASE}${path}`, { method, headers, body, signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('Run stopped by user.'), { code: 'RUN_STOPPED' })
    throw error
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw Object.assign(new Error(`Surfer ${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`), { statusCode: response.status })
  }
  if (response.status === 204) return accept.startsWith('text/') ? '' : null
  return accept.startsWith('text/') ? response.text() : response.json()
}

// Returns { id, state, permalinks, content_score, target_word_count, ... }
export async function createContentEditor(workspaceId, mainKeyword, { signal } = {}) {
  return surferFetch(`/workspaces/${workspaceId}/content_editors`, {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ main_keyword: mainKeyword, location: 'United States' }),
    signal,
  })
}

export async function getContentEditor(workspaceId, editorId, { signal } = {}) {
  return surferFetch(`/workspaces/${workspaceId}/content_editors/${editorId}`, { signal })
}

// { status, terms: [{ item, heading, included, target_range: { min, max } }] }
export async function getSeoGuidelines(workspaceId, editorId, { signal } = {}) {
  return surferFetch(`/workspaces/${workspaceId}/content_editors/${editorId}/seo_guidelines`, { signal })
}

// Replaces the editor's document body. Surfer recomputes the score asynchronously after.
export async function putEditorContent(workspaceId, editorId, markdown, { signal } = {}) {
  return surferFetch(`/workspaces/${workspaceId}/content_editors/${editorId}/content`, {
    method: 'PUT',
    accept: 'text/markdown',
    contentType: 'text/markdown',
    body: markdown,
    signal,
  })
}

export function editorEditUrl(editor) {
  return editor?.permalinks?.find((p) => p.type === 'edit')?.url || ''
}
