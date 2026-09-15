import SitemapEvent from '../models/SitemapEvent.js'
import { getGoogleAccessToken, isGoogleServiceAccountConfigured } from './googleAuth.js'
import { getWordPressSiteUrl, isWordPressConfigured, listWordPressRecentlyModified } from './wordpress.js'

// Sitemap automation for the blog.
//
// Yoast already BUILDS the sitemap (sitemap_index.xml, declared in robots.txt)
// and rebuilds it the moment a post is published or edited. What nobody did was
// tell Google. The old "ping" endpoint Google used to accept was switched off in
// 2023, so today the only supported way to say "the sitemap changed, come and
// look" is to (re)submit it through the Search Console API. That is what this
// does — plus two checks that make the submission honest: that the sitemap is
// reachable, and that the URL we just published is actually in it (SiteGround's
// proxy caches the sitemap, so a stale copy is possible for a while).
//
// Two entry points:
//   refreshSitemap({ urls })  — run right after the CRM publishes or edits a post.
//   startSitemapWatcher()     — polls WordPress for posts published/edited from
//                               inside wp-admin, which the CRM never hears about,
//                               and runs the same refresh for them.
//
// Both are best-effort. A sitemap problem is reported, never thrown into the
// publish path.

const GSC_API = 'https://www.googleapis.com/webmasters/v3'
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters'
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
const FETCH_TIMEOUT_MS = Number(process.env.SITEMAP_FETCH_TIMEOUT_MS || 20000)
const MAX_SITEMAP_URLS = 5000

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max)
}

export function getSitemapUrl() {
  const explicit = clean(process.env.SITEMAP_URL)
  if (explicit) return explicit
  const site = getWordPressSiteUrl()
  return site ? `${site}/sitemap_index.xml` : ''
}

// The Search Console property the sitemap is submitted to. GSC_SITE_URL wins
// when set (a URL-prefix property must be given verbatim, trailing slash
// included; a domain property is `sc-domain:host`). Otherwise the property is
// DISCOVERED: the service account lists the properties it has been added to
// and the one for the site's host is used — trustedtechnology.ai is a
// URL-prefix property, and guessing sc-domain: was a permission error.
export function getSearchConsoleSiteUrl() {
  return clean(process.env.GSC_SITE_URL)
}

function siteHost() {
  try {
    return new URL(getWordPressSiteUrl()).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function isSearchConsoleConfigured() {
  return Boolean(isGoogleServiceAccountConfigured() && (getSearchConsoleSiteUrl() || siteHost()))
}

let resolvedSite = null

// Lists the properties the service account can see and picks the one for the
// blog's host. A domain property is preferred when both exist because it
// covers every protocol and subdomain. Cached for the process lifetime; the
// explicit env value bypasses the lookup entirely.
export async function resolveSearchConsoleSiteUrl() {
  const explicit = getSearchConsoleSiteUrl()
  if (explicit) return explicit
  if (resolvedSite) return resolvedSite
  const host = siteHost()
  if (!host) throw Object.assign(new Error('WORDPRESS_URL is not configured, so the Search Console property cannot be inferred.'), { statusCode: 503 })
  const token = await getGoogleAccessToken(GSC_SCOPE)
  const response = await fetch(`${GSC_API}/sites`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error?.message || `Search Console site listing failed (${response.status}).`)
  const entries = Array.isArray(payload?.siteEntry) ? payload.siteEntry : []
  const matches = entries.filter((entry) => {
    const url = String(entry.siteUrl || '')
    if (url.startsWith('sc-domain:')) return url.slice('sc-domain:'.length).toLowerCase() === host
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') === host } catch { return false }
  })
  const usable = matches.filter((entry) => entry.permissionLevel !== 'siteUnverifiedUser')
  const chosen = usable.find((entry) => String(entry.siteUrl).startsWith('sc-domain:')) || usable[0]
  if (!chosen) {
    const seen = entries.map((entry) => entry.siteUrl).join(', ') || 'none'
    throw new Error(`The service account is not a user on any Search Console property for ${host} (it can see: ${seen}). Add it under Settings → Users and permissions with Full permission.`)
  }
  resolvedSite = String(chosen.siteUrl)
  return resolvedSite
}

function indexNowConfig() {
  const key = clean(process.env.INDEXNOW_KEY, 128)
  const keyLocation = clean(process.env.INDEXNOW_KEY_LOCATION)
  return key ? { key, keyLocation } : null
}

// URLs are compared the way a crawler sees them: same host, same path, and a
// trailing slash is not a difference.
export function normaliseUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    url.hash = ''
    url.search = ''
    url.hostname = url.hostname.toLowerCase()
    let path = url.pathname.replace(/\/+$/, '')
    if (!path) path = ''
    return `${url.protocol}//${url.hostname}${path}`
  } catch {
    return ''
  }
}

async function fetchText(url, { bypassCache = false, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    // A unique query string gets past the edge cache without touching the
    // canonical URL Google fetches. Yoast ignores the query and serves the
    // live sitemap.
    const target = bypassCache ? `${url}${url.includes('?') ? '&' : '?'}nocache=${Date.now()}` : url
    const response = await fetch(target, {
      signal: controller.signal,
      headers: { Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8', 'User-Agent': 'TrustedTechHub-SitemapCheck/1.0' },
    })
    const text = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, text, cached: response.headers.get('x-proxy-cache') || '' }
  } finally {
    clearTimeout(timer)
  }
}

// Minimal sitemap parser: a sitemap is a flat list of <sitemap>/<url> entries
// with <loc> and optional <lastmod>. Nothing here needs a full XML library.
export function parseSitemap(xml) {
  const text = String(xml || '')
  const isIndex = /<sitemapindex[\s>]/i.test(text)
  const tag = isIndex ? 'sitemap' : 'url'
  const entries = []
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi')
  let match
  while ((match = pattern.exec(text)) && entries.length < MAX_SITEMAP_URLS) {
    const block = match[1]
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1]
    if (!loc) continue
    const lastmod = block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1] || ''
    entries.push({ loc: loc.trim(), lastmod: lastmod.trim() })
  }
  return { type: isIndex ? 'index' : 'urlset', entries }
}

// The whole sitemap, index and children flattened: every URL the site declares
// crawlable, with the child sitemap it came from.
export async function readSitemap({ bypassCache = false, signal } = {}) {
  const sitemapUrl = getSitemapUrl()
  if (!sitemapUrl) throw Object.assign(new Error('WORDPRESS_URL (or SITEMAP_URL) is not configured.'), { statusCode: 503 })
  const root = await fetchText(sitemapUrl, { bypassCache, signal })
  if (!root.ok) {
    return { sitemapUrl, reachable: false, httpStatus: root.status, children: [], urls: [] }
  }
  const parsed = parseSitemap(root.text)
  const children = []
  const urls = []
  if (parsed.type === 'urlset') {
    urls.push(...parsed.entries.map((entry) => ({ ...entry, sitemap: sitemapUrl })))
  } else {
    for (const child of parsed.entries) {
      const page = await fetchText(child.loc, { bypassCache, signal }).catch((error) => ({ ok: false, status: 0, text: '', error }))
      const childParsed = page.ok ? parseSitemap(page.text) : { entries: [] }
      children.push({ loc: child.loc, lastmod: child.lastmod, httpStatus: page.status, urlCount: childParsed.entries.length })
      for (const entry of childParsed.entries) {
        if (urls.length >= MAX_SITEMAP_URLS) break
        urls.push({ ...entry, sitemap: child.loc })
      }
    }
  }
  const latestLastmod = [...children.map((c) => c.lastmod), ...urls.map((u) => u.lastmod)]
    .filter(Boolean)
    .sort()
    .pop() || ''
  return { sitemapUrl, reachable: true, httpStatus: root.status, cached: root.cached, children, urls, latestLastmod }
}

export function findInSitemap(sitemap, url) {
  const wanted = normaliseUrl(url)
  if (!wanted) return null
  return sitemap.urls.find((entry) => normaliseUrl(entry.loc) === wanted) || null
}

// ---------------------------------------------------------------------------
// Google Search Console
// ---------------------------------------------------------------------------

async function gscRequest(path, { method = 'GET' } = {}) {
  const site = await resolveSearchConsoleSiteUrl()
  const token = await getGoogleAccessToken(GSC_SCOPE)
  const response = await fetch(`${GSC_API}/sites/${encodeURIComponent(site)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload?.error?.message || `Search Console request failed (${response.status}).`
    const error = new Error(message)
    error.statusCode = response.status
    // 403 is nearly always "the service account has not been added to the
    // property" — say so, because the raw message does not.
    if (response.status === 403) {
      error.message = `${message} Add the service account as a user (Full permission) on the Search Console property ${site}.`
    }
    throw error
  }
  return payload
}

// PUT is Google's "submit this sitemap" verb; calling it for an already-listed
// sitemap re-queues it for a fresh download, which is exactly the point.
export async function submitSitemapToSearchConsole(sitemapUrl = getSitemapUrl()) {
  if (!isSearchConsoleConfigured()) return { submitted: false, reason: 'Search Console is not configured (GOOGLE_APPLICATION_CREDENTIALS + GSC_SITE_URL).' }
  await gscRequest(`/sitemaps/${encodeURIComponent(sitemapUrl)}`, { method: 'PUT' })
  return { submitted: true, sitemapUrl, siteUrl: await resolveSearchConsoleSiteUrl(), submittedAt: new Date().toISOString() }
}

// What Google knows about the sitemap: when it last fetched it, how many URLs it
// found, and any errors — the closest thing to "did Google see the new post".
export async function getSearchConsoleSitemapStatus(sitemapUrl = getSitemapUrl()) {
  if (!isSearchConsoleConfigured()) return { configured: false }
  const entry = await gscRequest(`/sitemaps/${encodeURIComponent(sitemapUrl)}`)
  const submitted = (entry.contents || []).reduce((total, part) => total + Number(part.submitted || 0), 0)
  const indexed = (entry.contents || []).reduce((total, part) => total + Number(part.indexed || 0), 0)
  return {
    configured: true,
    siteUrl: await resolveSearchConsoleSiteUrl(),
    sitemapUrl,
    lastSubmitted: entry.lastSubmitted || '',
    lastDownloaded: entry.lastDownloaded || '',
    isPending: Boolean(entry.isPending),
    errors: Number(entry.errors || 0),
    warnings: Number(entry.warnings || 0),
    submittedUrls: submitted,
    indexedUrls: indexed,
  }
}

// ---------------------------------------------------------------------------
// IndexNow (Bing, Yandex, Seznam, Naver — Google does not consume it)
// ---------------------------------------------------------------------------

export async function notifyIndexNow(urls) {
  const config = indexNowConfig()
  const list = [...new Set(urls.map((url) => clean(url)).filter(Boolean))].slice(0, 10000)
  if (!config) return { notified: false, reason: 'INDEXNOW_KEY is not set.' }
  if (!list.length) return { notified: false, reason: 'No URLs to submit.' }
  const host = new URL(list[0]).hostname
  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key: config.key, ...(config.keyLocation ? { keyLocation: config.keyLocation } : {}), urlList: list }),
  })
  // 200/202 both mean accepted.
  if (response.status !== 200 && response.status !== 202) {
    const text = await response.text().catch(() => '')
    throw new Error(`IndexNow rejected the submission (${response.status}) ${text.slice(0, 200)}`.trim())
  }
  return { notified: true, count: list.length, status: response.status, notifiedAt: new Date().toISOString() }
}

// ---------------------------------------------------------------------------
// The refresh: verify, then notify
// ---------------------------------------------------------------------------

async function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
}

// Yoast regenerates on publish, but the edge cache can hand out the previous
// copy for a while. Look at the LIVE sitemap (cache bypassed) with a few
// retries, and separately note whether the cached copy Google would fetch is
// still behind.
async function verifyUrls(urls, { attempts = 4, delayMs = 5000, signal } = {}) {
  const wanted = urls.map((url) => clean(url)).filter(Boolean)
  let live = null
  let missing = wanted
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    live = await readSitemap({ bypassCache: true, signal })
    if (!live.reachable) break
    missing = wanted.filter((url) => !findInSitemap(live, url))
    if (!missing.length) break
    if (attempt < attempts - 1) await sleep(delayMs, signal)
  }
  let cachedStale = false
  if (live?.reachable && wanted.length && !missing.length) {
    const cached = await readSitemap({ bypassCache: false, signal }).catch(() => null)
    cachedStale = Boolean(cached?.reachable) && wanted.some((url) => !findInSitemap(cached, url))
  }
  return {
    reachable: Boolean(live?.reachable),
    httpStatus: live?.httpStatus ?? 0,
    totalUrls: live?.urls?.length ?? 0,
    latestLastmod: live?.latestLastmod || '',
    found: wanted.filter((url) => !missing.includes(url)).map((url) => ({ url, lastmod: findInSitemap(live, url)?.lastmod || '' })),
    missing,
    cachedStale,
  }
}

// Run after a post goes live or changes. Returns a record of what was checked
// and who was told; the caller stores it (on the run, and in the event log).
export async function refreshSitemap({ urls = [], reason = 'manual', signal } = {}) {
  const sitemapUrl = getSitemapUrl()
  const startedAt = new Date().toISOString()
  const result = { sitemapUrl, reason, startedAt, urls: urls.map((url) => clean(url)).filter(Boolean), verification: null, searchConsole: null, indexNow: null, ok: false, summary: '' }

  try {
    result.verification = await verifyUrls(result.urls, { signal })
  } catch (error) {
    result.verification = { reachable: false, error: clean(error.message, 300), found: [], missing: result.urls, cachedStale: false }
  }

  try {
    result.searchConsole = await submitSitemapToSearchConsole(sitemapUrl)
  } catch (error) {
    result.searchConsole = { submitted: false, error: clean(error.message, 300) }
  }

  if (result.urls.length) {
    try {
      result.indexNow = await notifyIndexNow(result.urls)
    } catch (error) {
      result.indexNow = { notified: false, error: clean(error.message, 300) }
    }
  } else {
    result.indexNow = { notified: false, reason: 'No URLs to submit.' }
  }

  const v = result.verification
  const parts = []
  if (!v.reachable) parts.push(`Sitemap ${sitemapUrl} is not reachable${v.httpStatus ? ` (HTTP ${v.httpStatus})` : ''}.`)
  else if (result.urls.length && v.missing.length) parts.push(`${v.missing.length} of ${result.urls.length} URL(s) not yet in the sitemap.`)
  else if (result.urls.length) parts.push(`${v.found.length} URL(s) confirmed in the sitemap${v.cachedStale ? ' (edge cache still serving the previous copy)' : ''}.`)
  else parts.push(`Sitemap reachable with ${v.totalUrls} URL(s).`)
  parts.push(result.searchConsole.submitted ? 'Submitted to Google Search Console.' : `Search Console: ${result.searchConsole.reason || result.searchConsole.error}`)
  if (result.indexNow?.notified) parts.push(`IndexNow told about ${result.indexNow.count} URL(s).`)
  result.ok = v.reachable && !v.missing.length && (result.searchConsole.submitted || !isSearchConsoleConfigured())
  result.summary = parts.join(' ')
  result.finishedAt = new Date().toISOString()

  await SitemapEvent.create({ ...result, urls: result.urls }).catch((error) => console.error('[sitemap] could not record event', error.message))
  console.log(`[sitemap] ${reason}: ${result.summary}`)
  return result
}

// ---------------------------------------------------------------------------
// Status for the UI
// ---------------------------------------------------------------------------

export async function getSitemapStatus() {
  const sitemapUrl = getSitemapUrl()
  const [sitemap, searchConsole, recent] = await Promise.all([
    sitemapUrl ? readSitemap({ bypassCache: true }).catch((error) => ({ sitemapUrl, reachable: false, error: clean(error.message, 300), children: [], urls: [] })) : { sitemapUrl: '', reachable: false, children: [], urls: [] },
    getSearchConsoleSitemapStatus(sitemapUrl).catch((error) => ({ configured: isSearchConsoleConfigured(), error: clean(error.message, 300) })),
    SitemapEvent.find({}).sort({ createdAt: -1 }).limit(10).lean().catch(() => []),
  ])
  return {
    sitemapUrl,
    reachable: sitemap.reachable,
    httpStatus: sitemap.httpStatus ?? 0,
    error: sitemap.error || '',
    totalUrls: sitemap.urls.length,
    latestLastmod: sitemap.latestLastmod || '',
    children: sitemap.children.map(({ loc, lastmod, urlCount }) => ({ loc, lastmod, urlCount })),
    searchConsole,
    indexNow: { configured: Boolean(indexNowConfig()) },
    watcher: watcherState(),
    recent: recent.map((event) => ({
      at: event.finishedAt || event.createdAt,
      reason: event.reason,
      ok: event.ok,
      summary: event.summary,
      urls: event.urls,
    })),
  }
}

// ---------------------------------------------------------------------------
// Watcher: posts published or edited from inside WordPress
// ---------------------------------------------------------------------------

const WATCH_INTERVAL_MS = Number(process.env.SITEMAP_WATCH_INTERVAL_MS || 10 * 60 * 1000)
const WATCH_INITIAL_DELAY_MS = Number(process.env.SITEMAP_WATCH_INITIAL_DELAY_MS || 90 * 1000)
const watcher = { enabled: false, intervalMs: WATCH_INTERVAL_MS, lastRunAt: '', lastResult: '', running: false, seen: new Map() }

function watcherState() {
  return { enabled: watcher.enabled, intervalMs: watcher.intervalMs, lastRunAt: watcher.lastRunAt, lastResult: watcher.lastResult }
}

// One tick: anything published or modified since the last tick gets a refresh.
// The first tick only primes `seen` — every existing post would otherwise be
// treated as new and re-submitted on every boot.
export async function runSitemapWatchTick() {
  if (watcher.running || !isWordPressConfigured()) return null
  watcher.running = true
  try {
    const items = await listWordPressRecentlyModified({ perPage: 50 })
    const changed = []
    const priming = watcher.seen.size === 0
    for (const item of items) {
      const key = `${item.type}:${item.id}`
      const stamp = String(item.modified_gmt || item.modified || '')
      const previous = watcher.seen.get(key)
      watcher.seen.set(key, stamp)
      if (!priming && previous !== stamp && item.link) changed.push(item.link)
    }
    watcher.lastRunAt = new Date().toISOString()
    if (priming) {
      watcher.lastResult = `Primed with ${items.length} published item(s); watching for changes.`
      return null
    }
    if (!changed.length) {
      watcher.lastResult = 'No new or changed posts.'
      return null
    }
    const result = await refreshSitemap({ urls: changed, reason: 'wordpress_change' })
    watcher.lastResult = result.summary
    return result
  } catch (error) {
    watcher.lastResult = `Watcher error: ${clean(error.message, 300)}`
    console.error('[sitemap] watcher tick failed', error.message)
    return null
  } finally {
    watcher.running = false
  }
}

export function startSitemapWatcher() {
  if (String(process.env.SITEMAP_WATCH_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('Sitemap watcher disabled (SITEMAP_WATCH_ENABLED=false).')
    return
  }
  if (!isWordPressConfigured()) {
    console.log('Sitemap watcher not started: WordPress is not configured.')
    return
  }
  watcher.enabled = true
  console.log(`Sitemap watcher: every ${Math.round(WATCH_INTERVAL_MS / 60000)}m (first check in ${Math.round(WATCH_INITIAL_DELAY_MS / 1000)}s).`)
  const first = setTimeout(() => { void runSitemapWatchTick() }, WATCH_INITIAL_DELAY_MS)
  first.unref?.()
  const timer = setInterval(() => { void runSitemapWatchTick() }, WATCH_INTERVAL_MS)
  timer.unref?.()
}
