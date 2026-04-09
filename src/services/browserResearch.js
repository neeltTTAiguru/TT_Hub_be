import { execFile } from 'child_process'
import { promisify } from 'util'
import PublicPage from '../models/PublicPage.js'
import ResearchRun from '../models/ResearchRun.js'

const execFileAsync = promisify(execFile)
const BROWSER_PROFILE = process.env.OPENCLAW_BROWSER_PROFILE || 'openclaw'
const BROWSER_TIMEOUT_MS = Number(process.env.OPENCLAW_BROWSER_TIMEOUT_MS || 30000)

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
  await runBrowserCommand(['navigate', url])
  await runBrowserCommand(['wait', '--url', url])

  const pagePayload = await runBrowserCommand([
    'evaluate',
    '--fn',
    `() => JSON.stringify({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText : '',
      metaDescription: document.querySelector('meta[name="description"]')?.content || ''
    })`,
  ])

  const page = parseMaybeJson(pagePayload)

  if (!page || typeof page !== 'object') {
    const error = new Error('Unable to read page contents from OpenClaw browser.')
    error.statusCode = 502
    throw error
  }

  const text = trimText(String(page.text || ''))
  const summarySource = String(page.metaDescription || '') || text

  return {
    url: String(page.url || url),
    title: String(page.title || url),
    rawText: text,
    summary: buildSummary(summarySource),
    highlights: extractHighlights(text),
  }
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

export async function saveBrowserResearchRun({ objective, page, requestedBy = 'openclaw-browser' }) {
  return ResearchRun.create({
    title: `Browser capture: ${page.title}`,
    objective,
    scope: `Captured in OpenClaw browser from ${page.url}`,
    status: 'completed',
    requestedBy,
    findings: [
      {
        summary: page.summary || 'Browser capture saved.',
        implication: 'This public page is now available in the Trusted Tech Hub for future OpenClaw retrieval.',
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
      'Compare this source against Trusted Tech positioning or competitor messaging.',
    ],
    reportSummary: `Browser-captured public page saved from ${page.url}.`,
  })
}
