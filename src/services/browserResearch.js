import { execFile } from 'child_process'
import { promisify } from 'util'
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
        }))
      : [],
  }
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
      const results = []
      const seen = new Set()
      const selectors = [
        'main article',
        'main div.feed-shared-update-v2',
        'main div[data-urn]',
      ]

      const pushResult = (author, text) => {
        const normalizedText = normalize(text)
        if (!normalizedText || normalizedText.length < 80) return
        if (keyword && !normalizedText.toLowerCase().includes(keyword)) return
        if (seen.has(normalizedText)) return
        seen.add(normalizedText)
        results.push({
          author: normalize(author),
          text: normalizedText.slice(0, 1400),
        })
      }

      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => {
          const author =
            element.querySelector('.update-components-actor__title span')?.textContent ||
            element.querySelector('.feed-shared-actor__name')?.textContent ||
            element.querySelector('span[dir="ltr"]')?.textContent ||
            ''
          pushResult(author, element.innerText)
        })
      })

      if (!results.length) {
        const blocks = (document.body?.innerText || '').split(/\\n{2,}/)
        blocks.forEach((block) => pushResult('', block))
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

  return parsed
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
