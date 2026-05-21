import crypto from 'node:crypto'
import GrantOpportunity from '../models/GrantOpportunity.js'
import GrantSource from '../models/GrantSource.js'
import { buildGrantDiscoveryPrompt } from './grantDiscoveryPrompt.js'
import { ensureBrowserStarted, runBrowserCommand } from './browserResearch.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'
const MAX_SOURCE_TEXT = 12000
const MAX_CHILD_PAGES = 5

const GRANT_LINK_TERMS = [
  'grant',
  'grants',
  'funding',
  'opportunity',
  'opportunities',
  'application',
  'apply',
  'search',
  'register',
  'login',
  'log in',
  'solicitation',
  'program',
  'notice',
  'rfp',
]

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeStateCode(value) {
  return compactWhitespace(value).toUpperCase()
}

function normalizeSearchText(value) {
  return compactWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sourceQueryForState(state, stateCode) {
  const normalizedState = compactWhitespace(state)
  const normalizedStateCode = normalizeStateCode(stateCode || state)

  return {
    isActive: true,
    $or: [
      { state: new RegExp(`^${normalizedState.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      { stateCode: normalizedStateCode },
    ],
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

function parseJsonObject(raw) {
  let value = raw

  for (let index = 0; index < 3; index += 1) {
    if (value && typeof value === 'object') {
      return value
    }

    if (typeof value !== 'string') {
      break
    }

    const text = compactWhitespace(value)

    try {
      value = JSON.parse(text)
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) {
        throw new Error('Grant discovery returned non-JSON output.')
      }

      value = JSON.parse(match[0])
    }
  }

  throw new Error('Grant discovery returned an invalid JSON object.')
}

function opportunityIdFromGrant(grant) {
  return crypto
    .createHash('sha1')
    .update([
      grant.sourceUrl,
      grant.applicationUrl,
      grant.grantOpportunityName,
      grant.stateCode,
      grant.sponsor,
    ].map(compactWhitespace).join('|'))
    .digest('hex')
}

function scoreGrantLink(link) {
  const text = normalizeSearchText(`${link?.label || ''} ${link?.url || ''}`)

  if (!text) {
    return 0
  }

  let score = 0

  for (const term of GRANT_LINK_TERMS) {
    if (text.includes(normalizeSearchText(term))) {
      score += 10
    }
  }

  if (text.includes('search for grants')) score += 30
  if (text.includes('current') || text.includes('open')) score += 18
  if (text.includes('closed') || text.includes('prior') || text.includes('archive')) score -= 12
  if (text.includes('faq') || text.includes('privacy') || text.includes('accessibility')) score -= 16
  if (text.startsWith('mailto')) score -= 100

  return score
}

function getCandidateGrantLinks(page) {
  const seen = new Set([page.finalUrl, page.sourceUrl])

  return (Array.isArray(page.links) ? page.links : [])
    .map((link) => ({
      label: compactWhitespace(link?.label || ''),
      url: compactWhitespace(link?.url || ''),
      score: scoreGrantLink(link),
    }))
    .filter((link) => link.url && link.score > 0)
    .filter((link) => {
      if (seen.has(link.url)) {
        return false
      }

      seen.add(link.url)
      return true
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_CHILD_PAGES)
}

async function readPageSnapshot(url) {
  await runBrowserCommand(['open', url])
  await runBrowserCommand(['wait', '--url', url]).catch(() => {})
  await runBrowserCommand(['wait', '--fn', '() => document.body && document.body.innerText.length > 80']).catch(() => {})

  const raw = await runBrowserCommand([
    'evaluate',
    '--fn',
    `() => JSON.stringify({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText.slice(0, ${MAX_SOURCE_TEXT}) : '',
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 180).map((link) => ({
        label: (link.innerText || link.textContent || link.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(),
        url: link.href
      })).filter((link) => link.label || link.url)
    })`,
  ])

  return parseJsonObject(raw)
}

async function readGrantSource(source) {
  const payload = await readPageSnapshot(source.sourceUrl)
  const page = {
    sourceName: source.sourceName,
    sourceUrl: source.sourceUrl,
    category: source.category,
    focusArea: source.focusArea,
    sourceType: source.sourceType,
    crawlInstructions: source.crawlInstructions,
    pageTitle: String(payload?.title || ''),
    finalUrl: String(payload?.url || source.sourceUrl),
    pageText: String(payload?.text || ''),
    links: Array.isArray(payload?.links) ? payload.links : [],
  }

  const childPages = []
  const childErrors = []

  for (const link of getCandidateGrantLinks(page)) {
    try {
      const childPayload = await readPageSnapshot(link.url)
      childPages.push({
        label: link.label,
        requestedUrl: link.url,
        finalUrl: String(childPayload?.url || link.url),
        pageTitle: String(childPayload?.title || link.label || ''),
        pageText: String(childPayload?.text || ''),
        links: Array.isArray(childPayload?.links) ? childPayload.links.slice(0, 80) : [],
      })
    } catch (error) {
      childErrors.push({
        label: link.label,
        url: link.url,
        message: error instanceof Error ? error.message : 'Linked grant page could not be read',
      })
    }
  }

  return {
    ...page,
    childPages,
    childErrors,
  }
}

function normalizeGrantForSave(grant, fitBucket) {
  const title = compactWhitespace(grant.grantOpportunityName || grant.title || 'Untitled grant opportunity')
  const sourceUrl = compactWhitespace(grant.sourceUrl || grant.applicationUrl || '')
  const fitReasons = Array.isArray(grant.eligibilityFit?.reasons) ? grant.eligibilityFit.reasons : []
  const missing = Array.isArray(grant.eligibilityFit?.missingInformation) ? grant.eligibilityFit.missingInformation : []
  const unknowns = Array.isArray(grant.unknowns) ? grant.unknowns : []
  const focusAreas = [grant.focusArea, ...(Array.isArray(grant.fitTags) ? grant.fitTags : [])].map(compactWhitespace).filter(Boolean)

  return {
    opportunityId: opportunityIdFromGrant(grant),
    title,
    sourceAgency: compactWhitespace(grant.sponsor || 'Unknown'),
    sourceUrl,
    applicationUrl: compactWhitespace(grant.applicationUrl || sourceUrl),
    grantProgram: title,
    eligibility: Array.isArray(grant.eligibility)
      ? grant.eligibility.map((item) => compactWhitespace(item?.requirement || item)).filter(Boolean).join(' | ')
      : compactWhitespace(grant.eligibility),
    deadline: compactWhitespace(grant.grantDeadline || ''),
    awardRange: compactWhitespace(grant.amount || ''),
    matchRequired: compactWhitespace(grant.matchRequired || ''),
    focusAreas: Array.from(new Set(focusAreas)),
    fitTags: Array.from(new Set([fitBucket, grant.status, grant.category, grant.confidence].map(compactWhitespace).filter(Boolean))),
    fitScore: fitBucket === 'eligible' ? 90 : fitBucket === 'maybe' ? 65 : 25,
    summary: compactWhitespace(grant.summary || grant.publicSafetyRelevance || ''),
    sourceText: JSON.stringify({
      eligibilityFit: grant.eligibilityFit || {},
      stepsToRespond: grant.stepsToRespond || [],
      documents: grant.documents || [],
      unknowns,
      missingInformation: missing,
      reasons: fitReasons,
    }),
    sourceType: 'phase-2-grant-discovery',
    scannedAt: new Date().toISOString(),
  }
}

function flattenDiscoveredGrants(result) {
  return [
    ...(Array.isArray(result.eligibleGrants) ? result.eligibleGrants.map((grant) => ({ grant, fitBucket: 'eligible' })) : []),
    ...(Array.isArray(result.maybeEligibleGrants) ? result.maybeEligibleGrants.map((grant) => ({ grant, fitBucket: 'maybe' })) : []),
    ...(Array.isArray(result.notEligibleGrants) ? result.notEligibleGrants.map((grant) => ({ grant, fitBucket: 'not_eligible' })) : []),
  ]
}

export async function discoverGrantOpportunitiesForUser({
  state,
  stateCode,
  userProfile,
  save = true,
} = {}) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is not configured on the backend.')
    error.statusCode = 503
    throw error
  }

  const normalizedState = compactWhitespace(state || userProfile?.state)
  const normalizedStateCode = normalizeStateCode(stateCode || normalizedState)

  if (!normalizedState && !normalizedStateCode) {
    const error = new Error('State or state code is required for grant discovery.')
    error.statusCode = 400
    throw error
  }

  const sources = await GrantSource.find(sourceQueryForState(normalizedState, normalizedStateCode)).sort({
    category: 1,
    focusArea: 1,
    sourceName: 1,
  }).lean()

  if (!sources.length) {
    const error = new Error(`No active grant sources are saved for ${normalizedState || normalizedStateCode}.`)
    error.statusCode = 404
    throw error
  }

  await ensureBrowserStarted()

  const sourceReads = []
  const readErrors = []

  for (const source of sources) {
    try {
      sourceReads.push(await readGrantSource(source))
      await GrantSource.findByIdAndUpdate(source._id, {
        lastCheckedAt: new Date(),
        lastSuccessfulCheckAt: new Date(),
      })
    } catch (error) {
      readErrors.push({
        sourceName: source.sourceName,
        sourceUrl: source.sourceUrl,
        message: error instanceof Error ? error.message : 'Source read failed',
      })
      await GrantSource.findByIdAndUpdate(source._id, { lastCheckedAt: new Date() })
    }
  }

  const prompt = buildGrantDiscoveryPrompt({
    state: normalizedState,
    stateCode: normalizedStateCode,
    userProfile,
    grantSources: sourceReads,
  })

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: prompt,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    const error = new Error(body || `OpenAI request failed with ${response.status}`)
    error.statusCode = response.status
    throw error
  }

  const payload = await response.json()
  const rawText = getTextFromResponse(payload)
  const result = parseJsonObject(rawText)
  const normalizedOpportunities = flattenDiscoveredGrants(result).map(({ grant, fitBucket }) =>
    normalizeGrantForSave(grant, fitBucket),
  ).filter((grant) => grant.sourceUrl)

  const opportunities = save
    ? await Promise.all(
        normalizedOpportunities.map((grant) =>
          GrantOpportunity.findOneAndUpdate({ opportunityId: grant.opportunityId }, grant, {
            upsert: true,
            new: true,
            runValidators: true,
          }),
        ),
      )
    : normalizedOpportunities

  return {
    source: 'phase-2-grant-discovery',
    state: normalizedState,
    stateCode: normalizedStateCode,
    sources: sources.map((source) => ({
      sourceName: source.sourceName,
      sourceUrl: source.sourceUrl,
      focusArea: source.focusArea,
    })),
    readErrors,
    scannedAt: new Date().toISOString(),
    result,
    opportunities,
  }
}
