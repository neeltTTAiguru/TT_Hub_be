import crypto from 'node:crypto'
import GrantOpportunity from '../models/GrantOpportunity.js'
import { ensureBrowserStarted, runBrowserCommand } from './browserResearch.js'

const DEFAULT_LIMIT = 12
const DEFAULT_KEYWORDS = [
  'body camera',
  'body-worn camera',
  'digital evidence',
  'law enforcement technology',
  'public safety technology',
  'officer safety',
  'transparency',
]

const DEFAULT_SOURCES = [
  {
    sourceAgency: 'Grants.gov',
    url: 'https://www.grants.gov/search-grants',
  },
  {
    sourceAgency: 'Bureau of Justice Assistance',
    url: 'https://bja.ojp.gov/funding/current',
  },
  {
    sourceAgency: 'COPS Office',
    url: 'https://cops.usdoj.gov/grants',
  },
  {
    sourceAgency: 'FEMA Preparedness Grants',
    url: 'https://www.fema.gov/grants/preparedness',
  },
]

const GRANT_TERMS = [
  'grant',
  'funding',
  'solicitation',
  'opportunity',
  'application',
  'program',
  'award',
]

const PUBLIC_SAFETY_TERMS = [
  'law enforcement',
  'police',
  'sheriff',
  'public safety',
  'criminal justice',
  'justice',
  'officer safety',
]

const TECHNOLOGY_TERMS = [
  'body-worn',
  'body worn',
  'body camera',
  'camera',
  'digital evidence',
  'evidence',
  'technology',
  'software',
  'cloud',
  'redaction',
  'transcription',
  'records',
  'transparency',
]

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeSearchText(value) {
  return compactWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function trimText(value, limit = 5000) {
  const text = compactWhitespace(value)
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function parseBrowserJson(raw) {
  let value = raw

  for (let index = 0; index < 3; index += 1) {
    if (typeof value !== 'string') {
      return value
    }

    try {
      value = JSON.parse(value)
    } catch {
      return value
    }
  }

  return value
}

function absoluteUrl(href, baseUrl) {
  if (!href) return ''

  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return ''
  }
}

function sourceFromUrl(url) {
  try {
    const parsed = new URL(url)
    return {
      sourceAgency: parsed.hostname.replace(/^www\./, ''),
      url: parsed.toString(),
    }
  } catch {
    return null
  }
}

function opportunityIdFromUrl(url, title) {
  return crypto.createHash('sha1').update(`${url}|${title}`).digest('hex')
}

function findFirstPattern(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return compactWhitespace(match[1]).slice(0, 180)
    }
  }

  return ''
}

function inferDeadline(text) {
  return findFirstPattern(text, [
    /(?:deadline|due date|closing date|applications due|close date)\s*:?\s*([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:deadline|due date|closing date|applications due|close date)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /(?:closes?|closing)\s+(?:on\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
  ])
}

function inferAwardRange(text) {
  return findFirstPattern(text, [
    /(?:award(?:s)?|funding|amount)\s*:?\s*((?:up to\s*)?\$[\d,]+(?:\s*(?:-|to)\s*\$[\d,]+)?)/i,
    /((?:up to\s*)?\$[\d,]+(?:\s*(?:-|to)\s*\$[\d,]+)?\s+(?:per award|available|total))/i,
  ])
}

function inferEligibility(text) {
  return findFirstPattern(text, [
    /(?:eligible applicants|eligibility|who may apply)\s*:?\s*([^.;\n]{20,260})/i,
    /(state, local, tribal[^.;\n]{20,260})/i,
    /(law enforcement agencies[^.;\n]{0,180})/i,
  ])
}

function inferMatchRequired(text) {
  return findFirstPattern(text, [
    /(?:match|cost share|cost sharing)\s*:?\s*([^.;\n]{8,180})/i,
    /(no match required)/i,
  ])
}

function getMatchedTerms(text, terms) {
  const normalized = normalizeSearchText(text)
  return terms.filter((term) => normalized.includes(normalizeSearchText(term)))
}

function scoreOpportunity({ title, surroundingText, sourceAgency }, keywords) {
  const text = `${title} ${surroundingText} ${sourceAgency}`
  let score = 20

  score += Math.min(22, getMatchedTerms(text, GRANT_TERMS).length * 5)
  score += Math.min(24, getMatchedTerms(text, PUBLIC_SAFETY_TERMS).length * 6)
  score += Math.min(30, getMatchedTerms(text, TECHNOLOGY_TERMS).length * 6)
  score += Math.min(18, getMatchedTerms(text, keywords).length * 6)

  if (/closed|expired|archived/i.test(text)) score -= 22
  if (/current|open|available|apply/i.test(text)) score += 8

  return Math.max(1, Math.min(100, score))
}

function buildSummary(text) {
  const sentences = compactWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30)

  return sentences.slice(0, 2).join(' ').slice(0, 500)
}

async function readGrantSourcePage(source) {
  await runBrowserCommand(['open', source.url])
  await runBrowserCommand(['wait', '--url', source.url]).catch(() => {})
  await runBrowserCommand(['wait', '--fn', '() => document.body && document.body.innerText.length > 200']).catch(() => {})

  const raw = await runBrowserCommand([
    'evaluate',
    '--fn',
    `() => JSON.stringify({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText : '',
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 260).map((link) => {
        const label = (link.innerText || link.textContent || link.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim()
        const parentText = link.closest('li, article, section, div, tr')?.innerText?.replace(/\\s+/g, ' ').trim() || ''
        return {
          label,
          href: link.href,
          parentText: parentText.slice(0, 1200)
        }
      })
    })`,
  ])

  const payload = parseBrowserJson(raw)

  return {
    title: String(payload?.title || source.sourceAgency || ''),
    url: String(payload?.url || source.url),
    text: String(payload?.text || ''),
    links: Array.isArray(payload?.links) ? payload.links : [],
  }
}

function extractOpportunitiesFromPage(page, source, keywords) {
  const fallbackText = trimText(page.text)

  return page.links
    .map((link) => {
      const title = compactWhitespace(link?.label || '')
      const href = absoluteUrl(link?.href, page.url)
      const surroundingText = trimText(link?.parentText || title, 1600)
      const haystack = `${title} ${surroundingText}`
      const matchedGrantTerms = getMatchedTerms(haystack, GRANT_TERMS)
      const matchedPublicSafetyTerms = getMatchedTerms(haystack, PUBLIC_SAFETY_TERMS)
      const matchedTechTerms = getMatchedTerms(haystack, TECHNOLOGY_TERMS)
      const matchedKeywords = getMatchedTerms(haystack, keywords)

      if (!title || !href) return null
      if (!matchedGrantTerms.length && !matchedPublicSafetyTerms.length && !matchedKeywords.length) return null

      const focusAreas = Array.from(new Set([...matchedPublicSafetyTerms, ...matchedTechTerms, ...matchedKeywords]))
      const fitTags = Array.from(new Set([...matchedGrantTerms, ...focusAreas]))
      const sourceText = surroundingText || fallbackText
      const fitScore = scoreOpportunity({ title, surroundingText: sourceText, sourceAgency: source.sourceAgency }, keywords)

      return {
        opportunityId: opportunityIdFromUrl(href, title),
        title,
        sourceAgency: source.sourceAgency,
        sourceUrl: page.url,
        applicationUrl: href,
        grantProgram: title,
        eligibility: inferEligibility(sourceText),
        deadline: inferDeadline(sourceText),
        awardRange: inferAwardRange(sourceText),
        matchRequired: inferMatchRequired(sourceText),
        focusAreas,
        fitTags,
        fitScore,
        summary: buildSummary(sourceText) || `Potential grant opportunity found on ${source.sourceAgency}.`,
        sourceText,
        sourceType: 'openclaw-browser',
        scannedAt: new Date().toISOString(),
      }
    })
    .filter(Boolean)
}

function dedupeAndRank(opportunities, limit) {
  return Array.from(new Map(opportunities.map((opportunity) => [opportunity.opportunityId, opportunity])).values())
    .sort((left, right) => right.fitScore - left.fitScore)
    .slice(0, limit)
}

export async function searchGrantOpportunities({
  limit = DEFAULT_LIMIT,
  keywords = DEFAULT_KEYWORDS,
  state = '',
  agencyType = '',
  projectType = '',
  sourceUrls = [],
  save = true,
} = {}) {
  await ensureBrowserStarted()

  const normalizedKeywords = Array.from(
    new Set(
      [
        ...DEFAULT_KEYWORDS,
        ...(Array.isArray(keywords) ? keywords : []),
        state,
        agencyType,
        projectType,
      ]
        .map(compactWhitespace)
        .filter(Boolean),
    ),
  )
  const sources = [
    ...DEFAULT_SOURCES,
    ...(Array.isArray(sourceUrls)
      ? sourceUrls
          .map((url) => compactWhitespace(url))
          .filter(Boolean)
          .map(sourceFromUrl)
          .filter(Boolean)
      : []),
  ]
  const requestedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 30))
  const collected = []
  const errors = []

  for (const source of sources) {
    try {
      const page = await readGrantSourcePage(source)
      collected.push(...extractOpportunitiesFromPage(page, source, normalizedKeywords))
    } catch (error) {
      errors.push({
        source: source.sourceAgency,
        url: source.url,
        message: error instanceof Error ? error.message : 'Source scan failed',
      })
    }
  }

  const best = dedupeAndRank(collected, requestedLimit)
  const opportunities = save
    ? await Promise.all(
        best.map((opportunity) =>
          GrantOpportunity.findOneAndUpdate({ opportunityId: opportunity.opportunityId }, opportunity, {
            upsert: true,
            new: true,
            runValidators: true,
          }),
        ),
      )
    : best

  return {
    source: 'openclaw-browser',
    sources: sources.map((source) => source.url),
    keywords: normalizedKeywords,
    scannedAt: new Date().toISOString(),
    errors,
    opportunities,
  }
}
