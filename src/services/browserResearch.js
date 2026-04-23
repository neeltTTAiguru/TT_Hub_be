import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'node:fs/promises'
import PublicPage from '../models/PublicPage.js'
import ResearchRun from '../models/ResearchRun.js'

const execFileAsync = promisify(execFile)
const BROWSER_PROFILE = process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw'
const BROWSER_TIMEOUT_MS = Number(process.env.OPENCLAW_BROWSER_TIMEOUT_MS || 30000)
const MIN_CAPTURED_TEXT_LENGTH = Number(process.env.OPENCLAW_BROWSER_MIN_TEXT_LENGTH || 120)
const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

function getCliError(error) {
  if (typeof error?.stderr === 'string' && error.stderr.trim()) {
    return error.stderr.trim()
  }

  if (typeof error?.stdout === 'string' && error.stdout.trim()) {
    return error.stdout.trim()
  }

  return error instanceof Error ? error.message : 'Browser command failed'
}

async function runBrowserCommand(args) {
  try {
    const { stdout } = await execFileAsync(
      'openclaw',
      ['browser', '--browser-profile', BROWSER_PROFILE, '--timeout', String(BROWSER_TIMEOUT_MS), ...args],
      {
        timeout: BROWSER_TIMEOUT_MS + 5000,
        maxBuffer: 1024 * 1024 * 4,
      },
    )

    return stdout.trim()
  } catch (error) {
    const message = getCliError(error)
    const wrappedError = new Error(message)
    wrappedError.statusCode = 502
    throw wrappedError
  }
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

function hasUsablePageText(page) {
  return compactWhitespace(page.text || '').length >= MIN_CAPTURED_TEXT_LENGTH
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

async function waitForReadableContent() {
  try {
    await runBrowserCommand([
      'wait',
      '--fn',
      `() => {
        const text = document.body ? document.body.innerText || '' : ''
        return document.readyState === 'complete' && text.replace(/\\s+/g, ' ').trim().length >= ${MIN_CAPTURED_TEXT_LENGTH}
      }`,
    ])
  } catch {
    // Some pages never fully settle. We still attempt extraction below and return a clearer error if it fails.
  }
}

export async function ensureBrowserStarted() {
  try {
    await runBrowserCommand(['start'])
  } catch (error) {
    const wrappedError = new Error(
      `OpenClaw browser is unavailable. Start the browser profile locally and try again. Details: ${error.message}`,
    )
    wrappedError.statusCode = error.statusCode || 502
    throw wrappedError
  }
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

export async function capturePublicPage(url) {
  await ensureBrowserStarted()
  await runBrowserCommand(['open', url])
  await runBrowserCommand(['wait', '--url', url])
  await waitForReadableContent()

  const firstAttempt = await readPagePayload()
  let page = firstAttempt.page

  if ((!page || !hasUsablePageText(page)) && page?.url) {
    try {
      await runBrowserCommand(['wait', '--url', page.url])
      await waitForReadableContent()
    } catch {
      // Keep the first extraction result if the second wait fails.
    }

    const secondAttempt = await readPagePayload()
    page = secondAttempt.page || page
  }

  if (!page) {
    const error = new Error(
      `Unable to read page contents from OpenClaw browser. Raw response: ${firstAttempt.raw.slice(0, 300) || 'empty'}`,
    )
    error.statusCode = 502
    throw error
  }

  const normalizedText = compactWhitespace(page.text || '')

  if (!normalizedText) {
    const error = new Error(
      `OpenClaw browser reached the page but extracted no readable text from ${page.url || url}. The site may require additional interaction, consent, or block scripted reads.`,
    )
    error.statusCode = 502
    throw error
  }

  const text = trimText(normalizedText)
  const summarySource = String(page.metaDescription || '') || text

  return {
    url: String(page.url || url),
    title: String(page.title || url),
    rawText: text,
    summary: buildSummary(summarySource),
    highlights: extractHighlights(text),
  }
}

export async function captureLinkedInKeywordPosts(url, keyword) {
  await ensureBrowserStarted()
  await runBrowserCommand(['open', url])
  await runBrowserCommand(['wait', '--url', url])
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
      `OpenClaw opened the LinkedIn page but found no visible posts matching "${keyword}". Try a broader keyword or make sure the page shows recent posts.`,
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

export async function saveBrowserResearchRun({ objective, page, requestedBy = 'openclaw-browser' }) {
  const report = await generateBrowserResearchReport({ objective, page })

  return ResearchRun.create({
    title: `Browser capture: ${page.title}`,
    objective,
    scope: `Captured in OpenClaw browser from ${page.url}`,
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
