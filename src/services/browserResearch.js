import { readFile } from 'node:fs/promises'
import PublicPage from '../models/PublicPage.js'
import ResearchRun from '../models/ResearchRun.js'

const PAGE_FETCH_TIMEOUT_MS = Number(process.env.PAGE_FETCH_TIMEOUT_MS || 15000)
const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

// Interactive browser automation was removed (migrated off OpenClaw). Anything
// that needs a real, logged-in, JS-rendered browser session (surfers,
// screenshots) is disabled and returns a clean 501. Public, static page reads
// are served by plain server-side fetch (capturePublicPage below) — no browser.
const BROWSER_DISABLED_MESSAGE =
  'Interactive browser automation has been removed. This feature is disabled.'

function browserDisabledError() {
  const error = new Error(BROWSER_DISABLED_MESSAGE)
  error.statusCode = 501
  return error
}

export async function runBrowserCommand() {
  throw browserDisabledError()
}

function compactWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function trimText(value, limit = 6000) {
  const normalized = compactWhitespace(value)
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function buildSummary(text) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  return sentences.slice(0, 2).join(' ').slice(0, 400)
}

function extractHighlights(text) {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => compactWhitespace(sentence))
    .filter((sentence) => sentence.length > 40)

  return parts.slice(0, 5)
}

function parseMaybeJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function getTextFromResponse(payload) {
  if (!Array.isArray(payload?.output)) {
    return ''
  }

  return payload.output
    .flatMap((item) => {
      if (item?.type !== 'message' || !Array.isArray(item.content)) {
        return []
      }

      return item.content
        .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
        .map((content) => content.text)
    })
    .join('\n')
    .trim()
}

function parseNestedJson(raw, maxDepth = 3) {
  let current = raw

  for (let index = 0; index < maxDepth; index += 1) {
    if (typeof current !== 'string') {
      return current
    }

    const trimmed = current.trim()

    if (!trimmed) {
      return trimmed
    }

    const parsed = parseMaybeJson(trimmed)

    if (parsed === current) {
      return current
    }

    current = parsed
  }

  return current
}

function parsePagePayload(raw) {
  const page = parseNestedJson(raw)

  if (!page || typeof page !== 'object') {
    return null
  }

  return {
    title: String(page.title || ''),
    url: String(page.url || ''),
    text: String(page.text || ''),
    metaDescription: String(page.metaDescription || ''),
    readyState: String(page.readyState || ''),
  }
}

function parseLinkedInPostsPayload(raw) {
  const payload = parseNestedJson(raw)

  if (!payload || typeof payload !== 'object') {
    return null
  }

  return {
    title: String(payload.title || ''),
    url: String(payload.url || ''),
    keyword: String(payload.keyword || ''),
    posts: Array.isArray(payload.posts)
      ? payload.posts.map((post) => ({
          author: String(post?.author || ''),
          text: String(post?.text || ''),
          selector: String(post?.selector || ''),
        }))
      : [],
  }
}

function parseTwitterPostsPayload(raw) {
  const payload = parseNestedJson(raw)

  if (!payload || typeof payload !== 'object') {
    return null
  }

  return {
    title: String(payload.title || ''),
    url: String(payload.url || ''),
    keyword: String(payload.keyword || ''),
    posts: Array.isArray(payload.posts)
      ? payload.posts.map((post) => ({
          author: String(post?.author || ''),
          handle: String(post?.handle || ''),
          text: String(post?.text || ''),
          postedAt: String(post?.postedAt || ''),
          url: String(post?.url || ''),
          selector: String(post?.selector || ''),
        }))
      : [],
  }
}

function parseMediaPath(raw) {
  const trimmed = String(raw || '').trim()
  const mediaMatch = trimmed.match(/MEDIA:(.+)$/m)

  if (mediaMatch?.[1]?.trim()) {
    return mediaMatch[1].trim()
  }

  const line = trimmed
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('/') && /\.(png|jpg|jpeg)$/i.test(entry))

  return line || ''
}

async function readPagePayload() {
  const pagePayload = await runBrowserCommand([
    'evaluate',
    '--fn',
    `() => JSON.stringify({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText : '',
      metaDescription: document.querySelector('meta[name="description"]')?.content || '',
      readyState: document.readyState
    })`,
  ])

  return {
    raw: pagePayload,
    page: parsePagePayload(pagePayload),
  }
}

export async function ensureBrowserStarted() {
  throw browserDisabledError()
}

export async function openBrowserPage(url) {
  const trimmedUrl = String(url || '').trim()

  if (!trimmedUrl) {
    const error = new Error('A URL is required.')
    error.statusCode = 400
    throw error
  }

  await ensureBrowserStarted()
  await runBrowserCommand(['open', trimmedUrl])

  try {
    await runBrowserCommand(['wait', '--url', trimmedUrl])
  } catch {
    // Some sites redirect during login flows. Opening the page is still useful even if exact URL wait fails.
  }

  const payload = await readPagePayload()
  const page = payload.page

  return {
    title: String(page?.title || ''),
    url: String(page?.url || trimmedUrl),
    readyState: String(page?.readyState || ''),
  }
}

export async function getBrowserPageSnapshot() {
  await ensureBrowserStarted()
  const payload = await readPagePayload()
  const page = payload.page

  if (!page) {
    const error = new Error(`Unable to read current browser page. Raw response: ${payload.raw.slice(0, 300) || 'empty'}`)
    error.statusCode = 502
    throw error
  }

  return {
    title: String(page.title || ''),
    url: String(page.url || ''),
    readyState: String(page.readyState || ''),
    text: trimText(page.text || '', 2500),
  }
}

export async function getTwitterBrowserConnectionStatus() {
  const page = await getBrowserPageSnapshot()
  const hostname = page.url ? new URL(page.url).hostname.toLowerCase() : ''
  const isTwitterHost =
    hostname === 'x.com' ||
    hostname.endsWith('.x.com') ||
    hostname === 'twitter.com' ||
    hostname.endsWith('.twitter.com')
  const normalizedText = compactWhitespace(page.text || '').toLowerCase()
  const showsLoginPrompt =
    normalizedText.includes('sign in to x') ||
    normalizedText.includes('log in') ||
    normalizedText.includes('sign up') ||
    normalizedText.includes('create account')
  const showsAuthenticatedShell =
    normalizedText.includes('home') &&
    (normalizedText.includes('for you') ||
      normalizedText.includes('following') ||
      normalizedText.includes('post') ||
      normalizedText.includes('messages'))

  return {
    connected: Boolean(isTwitterHost && showsAuthenticatedShell && !showsLoginPrompt),
    browserReady: true,
    currentUrl: page.url,
    title: page.title,
    readyState: page.readyState,
    needsLogin: Boolean(isTwitterHost && showsLoginPrompt),
    source: 'server-fetch',
    message: isTwitterHost
      ? showsAuthenticatedShell && !showsLoginPrompt
        ? 'the browser appears signed in to X/Twitter.'
        : 'the browser is on X/Twitter, but the session does not look signed in yet.'
      : 'the browser is ready, but it is not currently on X/Twitter.',
  }
}

export async function captureBrowserScreenshot({ fullPage = false } = {}) {
  await ensureBrowserStarted()
  const raw = await runBrowserCommand([
    'screenshot',
    ...(fullPage ? ['--full-page'] : []),
  ])

  const mediaPath = parseMediaPath(raw)

  if (!mediaPath) {
    const error = new Error(`Unable to parse browser screenshot response: ${raw.slice(0, 200) || 'empty'}`)
    error.statusCode = 502
    throw error
  }

  const image = await readFile(mediaPath)
  return {
    mediaPath,
    dataUrl: `data:image/png;base64,${image.toString('base64')}`,
  }
}

async function captureElementScreenshot(selector) {
  const trimmedSelector = String(selector || '').trim()

  if (!trimmedSelector) {
    const error = new Error('A selector is required to capture an element screenshot.')
    error.statusCode = 400
    throw error
  }

  await ensureBrowserStarted()
  const raw = await runBrowserCommand([
    'screenshot',
    '--element',
    trimmedSelector,
  ])

  const mediaPath = parseMediaPath(raw)

  if (!mediaPath) {
    const error = new Error(`Unable to parse element screenshot response: ${raw.slice(0, 200) || 'empty'}`)
    error.statusCode = 502
    throw error
  }

  const image = await readFile(mediaPath)
  return {
    mediaPath,
    dataUrl: `data:image/png;base64,${image.toString('base64')}`,
  }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;|&#0*38;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTitle(html) {
  return (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim()
}

// Reads a public, static page via plain server-side fetch (no browser). Sites
// that require a logged-in / JS-rendered session cannot be read this way and
// should be handled by a dedicated integration, not scraped here.
export async function capturePublicPage(url) {
  const trimmedUrl = String(url || '').trim()
  if (!trimmedUrl) {
    const error = new Error('A URL is required.')
    error.statusCode = 400
    throw error
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS)
  let html = ''
  let finalUrl = trimmedUrl
  try {
    const response = await fetch(trimmedUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'TrustedTechHub/1.0 (+public-page-capture)',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!response.ok) {
      const error = new Error(`Could not load ${trimmedUrl} (HTTP ${response.status}).`)
      error.statusCode = 502
      throw error
    }
    finalUrl = response.url || trimmedUrl
    html = (await response.text()).slice(0, 800000)
  } catch (fetchError) {
    if (fetchError?.name === 'AbortError') {
      const error = new Error(`Timed out loading ${trimmedUrl}.`)
      error.statusCode = 504
      throw error
    }
    if (fetchError?.statusCode) throw fetchError
    const error = new Error(`Could not load ${trimmedUrl}: ${fetchError?.message || fetchError}`)
    error.statusCode = 502
    throw error
  } finally {
    clearTimeout(timer)
  }

  const normalizedText = htmlToText(html)
  if (!normalizedText) {
    const error = new Error(`Loaded ${finalUrl} but found no readable text (the site may require a browser).`)
    error.statusCode = 502
    throw error
  }

  const metaDescription =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || ''
  const text = trimText(normalizedText)
  const summarySource = compactWhitespace(metaDescription) || text

  return {
    url: finalUrl,
    title: extractTitle(html) || finalUrl,
    rawText: text,
    summary: buildSummary(summarySource),
    highlights: extractHighlights(text),
  }
}

export async function captureLinkedInKeywordPosts(url, keyword) {
  await ensureBrowserStarted()
  await runBrowserCommand(['open', url])
  await runBrowserCommand(['wait', '--url', url])

  const payload = await runBrowserCommand([
    'evaluate',
    '--fn',
    `() => {
      const keyword = ${JSON.stringify(keyword)}.trim().toLowerCase()
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim()
      const simplify = (value) =>
        normalize(value)
          .toLowerCase()
          .replace(/[^a-z0-9\\s-]/g, ' ')
          .replace(/-/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim()
      const singularize = (word) => {
        if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y'
        if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1)
        return word
      }
      const tokenize = (value) =>
        simplify(value)
          .split(' ')
          .map((part) => singularize(part.trim()))
          .filter((part) => part.length > 2)

      const synonymGroups = [
        ['body', 'bodi'],
        ['worn', 'wearable'],
        ['camera', 'cam', 'video'],
        ['evidence', 'digital', 'media'],
        ['management', 'manage', 'platform', 'system', 'software'],
        ['police', 'law', 'enforcement', 'public', 'safety'],
      ]

      const expandTokens = (tokens) => {
        const expanded = new Set(tokens)
        synonymGroups.forEach((group) => {
          if (group.some((variant) => expanded.has(variant))) {
            group.forEach((variant) => expanded.add(variant))
          }
        })
        return expanded
      }

      const keywordTokens = tokenize(keyword)
      const expandedKeywordTokens = expandTokens(keywordTokens)
      const matchesKeyword = (text) => {
        if (!keywordTokens.length) return true

        const normalizedText = simplify(text)
        if (!normalizedText) return false
        if (normalizedText.includes(simplify(keyword))) return true

        const textTokens = expandTokens(tokenize(normalizedText))
        let overlap = 0

        expandedKeywordTokens.forEach((token) => {
          if (textTokens.has(token)) overlap += 1
        })

        const requiredOverlap =
          keywordTokens.length <= 1 ? 1 : keywordTokens.length <= 3 ? 2 : Math.min(3, keywordTokens.length)

        return overlap >= requiredOverlap
      }

      const results = []
      const seen = new Set()
      const selectors = [
        'main article',
        'main div.feed-shared-update-v2',
        'main div[data-urn]',
      ]

      const getCssPath = (element) => {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return ''
        if (element.id) return '#' + CSS.escape(element.id)

        const segments = []
        let current = element

        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
          let segment = current.nodeName.toLowerCase()
          if (current.classList.length) {
            const stableClasses = Array.from(current.classList)
              .filter((className) =>
                className &&
                !/^(ember|artdeco|scaffold-layout__|occludable-update|feed-shared-update-v2__)/.test(className),
              )
              .slice(0, 2)

            if (stableClasses.length) {
              segment += stableClasses.map((className) => '.' + CSS.escape(className)).join('')
            }
          }

          let sibling = current
          let position = 1
          while ((sibling = sibling.previousElementSibling)) {
            if (sibling.nodeName.toLowerCase() === current.nodeName.toLowerCase()) {
              position += 1
            }
          }
          segment += ':nth-of-type(' + position + ')'
          segments.unshift(segment)
          current = current.parentElement
        }

        return ['body', ...segments].join(' > ')
      }

      const pushResult = (author, text, element) => {
        const normalizedText = normalize(text)
        if (!normalizedText || normalizedText.length < 80) return
        if (keyword && !matchesKeyword(normalizedText)) return
        if (seen.has(normalizedText)) return
        seen.add(normalizedText)
        results.push({
          author: normalize(author),
          text: normalizedText.slice(0, 1400),
          selector: getCssPath(element),
        })
      }

      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => {
          const author =
            element.querySelector('.update-components-actor__title span')?.textContent ||
            element.querySelector('.feed-shared-actor__name')?.textContent ||
            element.querySelector('span[dir="ltr"]')?.textContent ||
            ''
          pushResult(author, element.innerText, element)
        })
      })

      if (!results.length) {
        const blocks = (document.body?.innerText || '').split(/\\n{2,}/)
        blocks.forEach((block) => pushResult('', block, null))
      }

      return JSON.stringify({
        title: document.title,
        url: location.href,
        keyword,
        posts: results.slice(0, 8),
      })
    }`,
  ])

  const parsed = parseLinkedInPostsPayload(payload)

  if (!parsed) {
    const error = new Error(`Unable to parse LinkedIn post results. Raw response: ${payload.slice(0, 300) || 'empty'}`)
    error.statusCode = 502
    throw error
  }

  if (!parsed.posts.length) {
    const error = new Error(
      `The browser opened the LinkedIn page but found no visible posts matching "${keyword}". Try a broader keyword or make sure the page shows recent posts.`,
    )
    error.statusCode = 404
    throw error
  }
  let screenshot = null

  if (parsed.posts[0]?.selector) {
    try {
      screenshot = await captureElementScreenshot(parsed.posts[0].selector)
    } catch {
      screenshot = null
    }
  }

  return {
    ...parsed,
    screenshotDataUrl: screenshot?.dataUrl || '',
  }
}

export async function captureLinkedInSearchPosts(keyword) {
  const trimmedKeyword = keyword.trim()

  if (!trimmedKeyword) {
    const error = new Error('A LinkedIn search keyword is required.')
    error.statusCode = 400
    throw error
  }

  const searchUrl = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(trimmedKeyword)}`
  return captureLinkedInKeywordPosts(searchUrl, trimmedKeyword)
}

export async function captureTwitterKeywordPosts(url, keyword) {
  await ensureBrowserStarted()
  await runBrowserCommand(['open', url])

  try {
    await runBrowserCommand(['wait', '--url', url])
  } catch {
    // X/Twitter often rewrites search URLs. Extraction below validates whether useful posts are visible.
  }

  await waitForReadableContent()

  const payload = await runBrowserCommand([
    'evaluate',
    '--fn',
    `() => {
      const keyword = ${JSON.stringify(keyword)}.trim().toLowerCase()
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim()
      const simplify = (value) =>
        normalize(value)
          .toLowerCase()
          .replace(/[^a-z0-9\\s-]/g, ' ')
          .replace(/-/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim()

      const opportunityTerms = [
        'rfp',
        'bid',
        'bids',
        'solicitation',
        'procurement',
        'proposal',
        'proposals',
        'grant',
        'grants',
        'funding',
        'contract',
        'contracts',
        'purchase',
        'purchasing',
        'seeking',
        'vendor',
        'vendors',
        'body worn',
        'body-worn',
        'body camera',
        'body cameras',
        'bwc',
        'digital evidence',
      ]

      const searchTokens = simplify(keyword).split(' ').filter((token) => token.length > 2)
      const matchesKeyword = (text) => {
        const simplifiedText = simplify(text)
        if (!simplifiedText) return false
        if (!searchTokens.length) return true
        if (simplifiedText.includes(simplify(keyword))) return true

        let overlap = 0
        searchTokens.forEach((token) => {
          if (simplifiedText.includes(token)) overlap += 1
        })

        const hasOpportunityTerm = opportunityTerms.some((term) => simplifiedText.includes(simplify(term)))
        return overlap >= Math.min(2, searchTokens.length) || hasOpportunityTerm
      }

      const getCssPath = (element) => {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return ''
        if (element.id) return '#' + CSS.escape(element.id)

        const segments = []
        let current = element

        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
          let segment = current.nodeName.toLowerCase()

          if (current.getAttribute('data-testid')) {
            segment += '[data-testid="' + CSS.escape(current.getAttribute('data-testid')) + '"]'
          }

          let sibling = current
          let position = 1
          while ((sibling = sibling.previousElementSibling)) {
            if (sibling.nodeName.toLowerCase() === current.nodeName.toLowerCase()) {
              position += 1
            }
          }

          segment += ':nth-of-type(' + position + ')'
          segments.unshift(segment)
          current = current.parentElement
        }

        return ['body', ...segments].join(' > ')
      }

      const results = []
      const seen = new Set()
      const pushResult = (article) => {
        const text = normalize(article.innerText)
        if (!text || text.length < 40 || !matchesKeyword(text)) return
        if (seen.has(text)) return

        const timeElement = article.querySelector('time')
        const statusLink = timeElement?.closest('a')?.href || ''
        const userLink = article.querySelector('a[href^="/"][role="link"]')?.getAttribute('href') || ''
        const handleMatch = text.match(/@[A-Za-z0-9_]+/)

        seen.add(text)
        results.push({
          author: normalize(article.querySelector('[data-testid="User-Name"]')?.innerText || ''),
          handle: handleMatch ? handleMatch[0] : userLink,
          text: text.slice(0, 1400),
          postedAt: timeElement?.getAttribute('datetime') || '',
          url: statusLink,
          selector: getCssPath(article),
        })
      }

      document.querySelectorAll('article[data-testid="tweet"], article').forEach(pushResult)

      if (!results.length) {
        const blocks = (document.body?.innerText || '').split(/\\n{2,}/)
        blocks.forEach((block) => {
          const text = normalize(block)
          if (!text || text.length < 40 || !matchesKeyword(text) || seen.has(text)) return
          seen.add(text)
          results.push({
            author: '',
            handle: '',
            text: text.slice(0, 1400),
            postedAt: '',
            url: location.href,
            selector: '',
          })
        })
      }

      return JSON.stringify({
        title: document.title,
        url: location.href,
        keyword,
        posts: results.slice(0, 12),
      })
    }`,
  ])

  const parsed = parseTwitterPostsPayload(payload)

  if (!parsed) {
    const error = new Error(`Unable to parse Twitter post results. Raw response: ${payload.slice(0, 300) || 'empty'}`)
    error.statusCode = 502
    throw error
  }

  if (!parsed.posts.length) {
    const error = new Error(
      `The browser opened X/Twitter but found no visible posts matching "${keyword}". Make sure the browser profile is signed in, or try a broader keyword.`,
    )
    error.statusCode = 404
    throw error
  }

  let screenshot = null

  if (parsed.posts[0]?.selector) {
    try {
      screenshot = await captureElementScreenshot(parsed.posts[0].selector)
    } catch {
      screenshot = null
    }
  }

  return {
    ...parsed,
    screenshotDataUrl: screenshot?.dataUrl || '',
  }
}

export async function captureTwitterSearchPosts(keyword, { filter = 'live' } = {}) {
  const trimmedKeyword = keyword.trim()

  if (!trimmedKeyword) {
    const error = new Error('A Twitter/X search keyword is required.')
    error.statusCode = 400
    throw error
  }

  const searchUrl = `https://x.com/search?q=${encodeURIComponent(trimmedKeyword)}&src=typed_query${
    filter ? `&f=${encodeURIComponent(filter)}` : ''
  }`

  return captureTwitterKeywordPosts(searchUrl, trimmedKeyword)
}

export async function saveCapturedPublicPage(page, options = {}) {
  const slug = options.slug || new URL(page.url).pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'home'
  const pageType = options.pageType || 'browser-capture'

  return PublicPage.findOneAndUpdate(
    { url: page.url },
    {
      url: page.url,
      slug,
      title: page.title,
      pageType,
      summary: page.summary,
      highlights: page.highlights,
      rawText: page.rawText,
      sourceDomain: new URL(page.url).hostname,
      visibility: 'public',
      lastReviewedAt: new Date(),
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
    },
  )
}

async function generateBrowserResearchReport({ objective, page }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      summary: page.summary || 'Browser capture saved.',
      findings: [
        {
          summary: page.summary || 'Browser capture saved.',
          implication: 'This page is stored in the hub for later review.',
          confidence: 'medium',
          sources: [
            {
              label: page.title,
              url: page.url,
              sourceType: 'browser-capture',
            },
          ],
        },
      ],
      recommendedNextSteps: [
      'Review the saved page in the public pages collection.',
        'Compare this page against Trusted Tech positioning or competitor messaging.',
      ],
    }
  }

  const contentSlice = trimText(page.rawText || '', 2500)
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      text: {
        format: {
          type: 'json_schema',
          name: 'browser_capture_report',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: [
              'companyOverview',
              'targetCustomers',
              'keyClaims',
              'proofPoints',
              'strategicImplications',
              'recommendedNextSteps',
            ],
            properties: {
              companyOverview: { type: 'string' },
              targetCustomers: {
                type: 'array',
                maxItems: 3,
                items: { type: 'string' },
              },
              keyClaims: {
                type: 'array',
                maxItems: 4,
                items: { type: 'string' },
              },
              proofPoints: {
                type: 'array',
                maxItems: 4,
                items: { type: 'string' },
              },
              strategicImplications: {
                type: 'array',
                maxItems: 3,
                items: { type: 'string' },
              },
              recommendedNextSteps: {
                type: 'array',
                maxItems: 3,
                items: { type: 'string' },
              },
            },
          },
        },
      },
      input: [
        {
          role: 'system',
          content:
            'You generate short, specific, source-grounded website capture reports for Trusted Tech. Use only the provided page data. Be concrete, not generic. If a detail is not present, omit it rather than guessing.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Objective: ${objective}`,
                `Page title: ${page.title}`,
                `Page url: ${page.url}`,
                `Meta summary: ${page.summary || 'None'}`,
                'Captured page text excerpt:',
                contentSlice || 'No readable text extracted.',
                'Return a concise report focused on: what the company is offering, who it appears to target, the clearest product or positioning claims, any proof points, and what matters strategically for Trusted Tech.',
              ].join('\n\n'),
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    const error = new Error(body || `OpenAI request failed with ${response.status}`)
    error.statusCode = response.status
    throw error
  }

  const payload = await response.json()
  const content = getTextFromResponse(payload)
  const report = parseMaybeJson(content)

  if (!report || typeof report !== 'object') {
    throw new Error('OpenAI returned an invalid browser capture report.')
  }

  return {
    summary: [
      `Overview: ${String(report.companyOverview || page.summary || 'Browser capture saved.')}`,
      Array.isArray(report.targetCustomers) && report.targetCustomers.length
        ? `Target customers: ${report.targetCustomers.join('; ')}`
        : '',
      Array.isArray(report.keyClaims) && report.keyClaims.length
        ? `Key claims: ${report.keyClaims.join('; ')}`
        : '',
      Array.isArray(report.proofPoints) && report.proofPoints.length
        ? `Proof points: ${report.proofPoints.join('; ')}`
        : '',
      Array.isArray(report.strategicImplications) && report.strategicImplications.length
        ? `Strategic implications: ${report.strategicImplications.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    findings: [
      {
        summary: String(report.companyOverview || page.summary || 'Browser capture saved.'),
        implication:
          Array.isArray(report.targetCustomers) && report.targetCustomers.length
            ? `Target customers: ${report.targetCustomers.join('; ')}`
            : 'Target customer detail was limited on the captured page.',
        confidence: 'medium',
      },
      ...(Array.isArray(report.keyClaims) && report.keyClaims.length
        ? report.keyClaims.slice(0, 2).map((claim) => ({
            summary: String(claim),
            implication:
              Array.isArray(report.strategicImplications) && report.strategicImplications.length
                ? String(report.strategicImplications[0])
                : 'This claim may influence positioning or competitive messaging.',
            confidence: 'medium',
          }))
        : []),
      ...(Array.isArray(report.proofPoints) && report.proofPoints.length
        ? [
            {
              summary: `Proof points: ${report.proofPoints.join('; ')}`,
              implication: 'These proof points can be used to assess credibility and competitive differentiation.',
              confidence: 'medium',
            },
          ]
        : []),
    ],
    recommendedNextSteps: Array.isArray(report.recommendedNextSteps) ? report.recommendedNextSteps : [],
  }
}

export async function saveBrowserResearchRun({ objective, page, requestedBy = 'public-page-capture' }) {
  const report = await generateBrowserResearchReport({ objective, page })

  return ResearchRun.create({
    title: `Browser capture: ${page.title}`,
    objective,
    scope: `Captured in the browser from ${page.url}`,
    status: 'completed',
    requestedBy,
    findings: report.findings.map((finding) => ({
      summary: String(finding.summary || page.summary || 'Browser capture saved.'),
      implication: String(
        finding.implication || 'This public page is now available in the Trusted Tech Hub for future retrieval.',
      ),
      confidence: ['low', 'medium', 'high'].includes(finding.confidence) ? finding.confidence : 'medium',
      sources: [
        {
          label: page.title,
          url: page.url,
          sourceType: 'browser-capture',
        },
      ],
    })),
    recommendedNextSteps: report.recommendedNextSteps.length
      ? report.recommendedNextSteps
      : [
          'Review the saved page in the public pages collection.',
          'Compare this source against Trusted Tech positioning or competitor messaging.',
        ],
    reportSummary: report.summary,
  })
}
