import crypto from 'node:crypto'
import PoliceGrantLead from '../models/PoliceGrantLead.js'
import { ensureBrowserStarted, runBrowserCommand } from './browserResearch.js'

const BASE_URL = 'https://policefundingdatabase.org'
const LOCATION_INDEX_URL = `${BASE_URL}/explore-the-database/find-a-location/`
const DEFAULT_LIMIT = 10
const MAX_LOCATION_PAGES = 8
const TARGETED_LOCATION_PAGES = 12
const EXCLUDED_LOCATION_PAGE_BOOST = 12

const LARGE_CITY_NAMES = new Set([
  'los angeles',
  'new york',
  'chicago',
  'houston',
  'phoenix',
  'philadelphia',
  'san antonio',
  'san diego',
  'dallas',
  'san jose',
  'austin',
  'jacksonville',
  'fort worth',
  'columbus',
  'charlotte',
  'indianapolis',
  'san francisco',
  'seattle',
  'denver',
  'washington',
  'boston',
  'detroit',
  'memphis',
  'baltimore',
  'atlanta',
  'miami',
  'cleveland',
  'minneapolis',
  'st. louis',
])

const TECH_TERMS = [
  'body-worn',
  'body worn',
  'body camera',
  'camera',
  'evidence',
  'digital',
  'technology',
  'transparency',
  'accountability',
  'de-escalation',
  'training',
  'records',
  'data',
  'software',
  'cloud',
  'ai',
  'artificial intelligence',
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

function normalizeTextFromHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|th|h1|h2|h3|h4|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function absoluteUrl(href) {
  if (!href) return ''
  return new URL(href, BASE_URL).toString()
}

function slugToState(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function parseLocationLinks(html) {
  const links = []
  const pattern = /<a[^>]+href=["']([^"']*\/explore-the-database\/locations\/([^/"']+)\/([^/"']+)\/?)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match

  while ((match = pattern.exec(html))) {
    const [, href, stateSlug, locationSlug, rawLabel] = match
    const name = compactWhitespace(normalizeTextFromHtml(rawLabel))

    if (!name || name.length > 90) continue

    links.push({
      name,
      state: slugToState(stateSlug),
      url: absoluteUrl(href),
      locationSlug,
    })
  }

  const deduped = Array.from(new Map(links.map((link) => [link.url, link])).values())
  return deduped.sort((left, right) => scoreLocationCandidate(right) - scoreLocationCandidate(left))
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

function scoreLocationCandidate(location) {
  const name = location.name.toLowerCase()
  let score = 20

  if (name.includes('county')) score += 18
  if (!LARGE_CITY_NAMES.has(name)) score += 16
  if (name.length <= 12) score += 10
  if (/(mount|falls|springs|heights|beach|ridge|grove|lake|park|fort|junction|valley|village|town)/i.test(name)) score += 8
  if (LARGE_CITY_NAMES.has(name)) score -= 28

  return score
}

function scoreLocationForInstructions(location, instructions = '') {
  const normalizedInstructions = normalizeSearchText(instructions)

  if (!normalizedInstructions) {
    return scoreLocationCandidate(location)
  }

  const haystack = normalizeSearchText(`${location.name} ${location.state} ${location.locationSlug}`)
  const instructionTerms = normalizedInstructions
    .split(' ')
    .filter((term) => term.length > 2 && !['the', 'and', 'for', 'near', 'into', 'lead', 'leads', 'county', 'counties', 'city', 'cities', 'police', 'sheriff'].includes(term))
  let score = scoreLocationCandidate(location)

  if (haystack.includes(normalizedInstructions)) score += 80
  if (normalizedInstructions.includes(normalizeSearchText(location.name))) score += 70
  if (normalizedInstructions.includes(normalizeSearchText(location.state))) score += 35
  if (normalizedInstructions.includes('county') && location.name.toLowerCase().includes('county')) score += 18

  for (const term of instructionTerms) {
    if (haystack.includes(term)) score += 16
  }

  return score
}

function scoreLeadForInstructions(lead, instructions = '') {
  const normalizedInstructions = normalizeSearchText(instructions)

  if (!normalizedInstructions) {
    return lead.opportunityScore
  }

  const haystack = normalizeSearchText(`${lead.agencyName} ${lead.locationName} ${lead.state}`)
  const terms = normalizedInstructions
    .split(' ')
    .filter((term) => term.length > 2 && !['the', 'and', 'for', 'near', 'into', 'lead', 'leads', 'county', 'counties', 'city', 'cities', 'police', 'sheriff'].includes(term))
  let score = lead.opportunityScore

  if (haystack.includes(normalizedInstructions)) score += 90
  if (normalizedInstructions.includes(normalizeSearchText(lead.locationName))) score += 80
  if (normalizedInstructions.includes(normalizeSearchText(lead.state))) score += 28

  for (const term of terms) {
    if (haystack.includes(term)) score += 22
  }

  return score
}

function agencyKeyFromParts(agencyName, locationName, state) {
  return normalizeSearchText(`${agencyName || ''}|${locationName || ''}|${state || ''}`)
}

function agencyKeyFromLead(lead) {
  return agencyKeyFromParts(lead.agencyName, lead.locationName, lead.state)
}

function parseMoney(value) {
  const number = String(value || '').replace(/[$,]/g, '')
  const parsed = Number(number)
  return Number.isFinite(parsed) ? parsed : 0
}

function moneyText(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

function extractLocationMeta(text) {
  const grantHeading = text.match(/Federal grant funding for\s+([^\n]+)/i)
  const locationName = compactWhitespace(grantHeading?.[1] || '')
  const staff = text.match(/Full-time law enforcement staff,\s*([^\n]+)[\s\S]*?([\d,]+)\s+Officers/i)
  const agencyName = compactWhitespace(staff?.[1] || '')
  const officers = staff ? Number(staff[2].replace(/,/g, '')) : 0

  return { locationName, agencyName, officers }
}

function estimateAgencySize(officers, locationName) {
  if (officers && officers < 50) return 'Small'
  if (officers && officers < 250) return 'Midsize'
  if (officers && officers >= 250) return 'Large'
  if (/county/i.test(locationName)) return 'County / unknown'
  return 'Unknown'
}

function splitGrantRows(text) {
  const start = text.indexOf('Recent grants')
  const endCandidates = ['Military equipment transfers', 'Local police misconduct data', 'Settlements']
    .map((label) => text.indexOf(label, start + 1))
    .filter((index) => index > start)
    .sort((left, right) => left - right)
  const section = start === -1 ? text : text.slice(start, endCandidates[0] || undefined)
  const rows = section.split(/(?=\$[\d,]+(?:\.\d{2})?\s+\d{1,2}\/\d{1,2}\/\d{4})/g)

  return rows
    .map((row) => compactWhitespace(row))
    .filter((row) => /^\$[\d,]+(?:\.\d{2})?\s+\d{1,2}\/\d{1,2}\/\d{4}/.test(row))
    .slice(0, 8)
}

function parseGrantRow(row, location, meta) {
  const pattern = /^(\$[\d,]+(?:\.\d{2})?)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+(.+?)\s+(Department of [A-Za-z ,&.-]+|Executive Office of the President|Office of [A-Za-z ,&.-]+)\s+([0-9.]+\s+.+?)\s+(Prime|Sub)$/i
  const match = row.match(pattern)
  const amount = parseMoney(match?.[1] || row.match(/^\$[\d,]+(?:\.\d{2})?/)?.[0] || '')
  const startDate = match?.[2] || ''
  const endDate = match?.[3] || ''
  const recipient = compactWhitespace(meta.agencyName || match?.[4] || meta.locationName || location.name)
  const description = compactWhitespace(match?.[5] || row).slice(0, 700)
  const fundingSource = compactWhitespace(match?.[6] || '')
  const fundingProgram = compactWhitespace(match?.[7] || '')

  return {
    agencyName: recipient,
    locationName: meta.locationName || location.name,
    state: location.state,
    estimatedAgencySize: estimateAgencySize(meta.officers, meta.locationName || location.name),
    grantAmount: amount,
    grantAmountText: amount ? moneyText(amount) : '',
    fundingProgram,
    fundingSource,
    grantDate: startDate,
    grantEndDate: endDate,
    description,
    sourceUrl: location.url,
  }
}

function getLikelyNeeds(description) {
  const text = description.toLowerCase()
  const needs = []

  if (/body.?worn|body camera|camera/.test(text)) needs.push('body cameras')
  if (/evidence|records|data/.test(text)) needs.push('evidence management')
  if (/digital|software|technology|cloud/.test(text)) needs.push('cloud storage')
  if (/redact|privacy|transparency|accountability/.test(text)) needs.push('redaction')
  if (/ai|artificial intelligence|transcription|report/.test(text)) needs.push('AI reporting')
  if (/training|de-escalation|officer safety|public safety/.test(text)) needs.push('practical deployment support')

  return needs.length ? Array.from(new Set(needs)) : ['grant-aligned modernization review']
}

function scoreGrantLead(lead) {
  const text = `${lead.description} ${lead.fundingProgram} ${lead.fundingSource}`.toLowerCase()
  let score = 34

  if (lead.grantAmount >= 1000000) score += 18
  else if (lead.grantAmount >= 250000) score += 14
  else if (lead.grantAmount >= 75000) score += 9

  if (/2026|2025|2024/.test(lead.grantDate)) score += 16
  if (lead.estimatedAgencySize === 'Small') score += 16
  if (lead.estimatedAgencySize === 'Midsize' || lead.estimatedAgencySize === 'County / unknown') score += 12
  if (lead.estimatedAgencySize === 'Large') score -= 18

  const matchedTerms = TECH_TERMS.filter((term) => text.includes(term)).length
  score += Math.min(18, matchedTerms * 4)

  if (/hiring|personnel|salary/.test(text) && matchedTerms === 0) score -= 10
  if (LARGE_CITY_NAMES.has(lead.locationName.toLowerCase())) score -= 12

  return Math.max(1, Math.min(100, score))
}

function recommendedAction(score) {
  if (score >= 78) return 'Immediate outreach'
  if (score >= 64) return 'High priority'
  if (score >= 42) return 'Monitor'
  return 'Low priority'
}

function enrichLead(lead) {
  const opportunityScore = scoreGrantLead(lead)
  const likelyNeeds = getLikelyNeeds(lead.description)
  const recommended = recommendedAction(opportunityScore)
  const leadId = crypto
    .createHash('sha1')
    .update([lead.sourceUrl, lead.agencyName, lead.grantAmount, lead.grantDate, lead.description.slice(0, 120)].join('|'))
    .digest('hex')

  return {
    ...lead,
    leadId,
    opportunityScore,
    likelyNeeds,
    recommendedAction: recommended,
    whyThisMatters: `${lead.agencyName} shows recent grant-backed public safety funding that may support practical modernization needs.`,
    startupOpportunity:
      recommended === 'Low priority'
        ? 'Keep this on the radar, but do not lead outreach unless more technology-specific funding appears.'
        : 'Position around affordability, easy deployment, low IT burden, and grant-aligned BWC/evidence workflows.',
    scannedAt: new Date().toISOString(),
  }
}

async function readPageViaBrowser(url) {
  let raw = ''
  let lastError = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (attempt > 0) {
        await ensureBrowserStarted()
      }

      await runBrowserCommand(['open', url])
      await runBrowserCommand(['wait', '--url', url]).catch(() => {})
      await runBrowserCommand(['wait', '--text', 'Police Funding Database']).catch(() => {})

      raw = await runBrowserCommand([
        'evaluate',
        '--fn',
        `() => JSON.stringify({
          html: document.documentElement ? document.documentElement.outerHTML : '',
          text: document.body ? document.body.innerText : '',
          url: location.href,
          title: document.title,
          readyState: document.readyState
        })`,
      ])
      break
    } catch (error) {
      lastError = error

      if (!/tab not found/i.test(error?.message || '') || attempt === 1) {
        throw error
      }
    }
  }

  if (!raw && lastError) {
    throw lastError
  }

  const payload = parseBrowserJson(raw)
  const html = String(payload?.html || '')
  const text = String(payload?.text || normalizeTextFromHtml(html))

  if (!html && !text) {
    const error = new Error(`Browser could not read Police Funding Database page: ${url}`)
    error.statusCode = 502
    throw error
  }

  return { html, text, url: String(payload?.url || url) }
}

async function collectLeadsFromLocation(location) {
  const { text } = await readPageViaBrowser(location.url)
  const meta = extractLocationMeta(text)

  return splitGrantRows(text)
    .map((row) => parseGrantRow(row, location, meta))
    .filter((lead) => lead.grantAmount > 0)
    .map(enrichLead)
}

function rankAndFilterLeads(collected, normalizedInstructions, excludedLeadIds, excludedAgencyKeys) {
  const deduped = Array.from(new Map(collected.map((lead) => [lead.leadId, lead])).values())
    .sort((left, right) => right.opportunityScore - left.opportunityScore)
  const bestByAgency = Array.from(
    deduped
      .reduce((map, lead) => {
        const key = agencyKeyFromLead(lead)
        const existing = map.get(key)

        if (!existing || lead.opportunityScore > existing.opportunityScore) {
          map.set(key, lead)
        }

        return map
      }, new Map())
      .values(),
  )

  const fresh = bestByAgency.filter(
    (lead) => !excludedLeadIds.has(lead.leadId) && !excludedAgencyKeys.has(agencyKeyFromLead(lead)),
  )

  return {
    skippedCount: bestByAgency.length - fresh.length,
    leads: fresh.sort(
      (left, right) => scoreLeadForInstructions(right, normalizedInstructions) - scoreLeadForInstructions(left, normalizedInstructions),
    ),
  }
}

export async function surfPoliceGrantDatabase({
  limit = DEFAULT_LIMIT,
  instructions = '',
  excludeLeadIds = [],
  excludeAgencyKeys = [],
  save = true,
} = {}) {
  await ensureBrowserStarted()

  const { html } = await readPageViaBrowser(LOCATION_INDEX_URL)
  const normalizedInstructions = compactWhitespace(instructions)
  const requestedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 25))
  const excludedLeadIds = new Set(excludeLeadIds.map((leadId) => compactWhitespace(leadId)).filter(Boolean))
  const excludedAgencyKeys = new Set(excludeAgencyKeys.map((key) => normalizeSearchText(key)).filter(Boolean))
  const hasExclusions = excludedLeadIds.size > 0 || excludedAgencyKeys.size > 0
  const baseLocationPages = normalizedInstructions ? TARGETED_LOCATION_PAGES : MAX_LOCATION_PAGES
  const maxLocationPages = baseLocationPages + (hasExclusions ? EXCLUDED_LOCATION_PAGE_BOOST : 0)
  const locations = parseLocationLinks(html)
    .sort((left, right) => scoreLocationForInstructions(right, normalizedInstructions) - scoreLocationForInstructions(left, normalizedInstructions))
    .slice(0, maxLocationPages)
  const collected = []
  let ranked = { skippedCount: 0, leads: [] }

  for (const location of locations) {
    try {
      const leads = await collectLeadsFromLocation(location)
      collected.push(...leads)
      ranked = rankAndFilterLeads(collected, normalizedInstructions, excludedLeadIds, excludedAgencyKeys)
    } catch {
      // Keep surfing other locations if one page is unavailable or has unexpected formatting.
    }

    if (ranked.leads.length >= requestedLimit && collected.length >= requestedLimit * 3) {
      break
    }
  }

  ranked = rankAndFilterLeads(collected, normalizedInstructions, excludedLeadIds, excludedAgencyKeys)
  const bestByAgency = ranked.leads.slice(0, requestedLimit)

  const leads = save
    ? await Promise.all(
        bestByAgency.map((lead) =>
          PoliceGrantLead.findOneAndUpdate({ leadId: lead.leadId }, lead, {
            upsert: true,
            new: true,
            runValidators: true,
          }),
        ),
      )
    : bestByAgency

  return {
    source: 'policefundingdatabase.org',
    searchUrl: LOCATION_INDEX_URL,
    instructions: normalizedInstructions,
    scannedAt: new Date().toISOString(),
    skippedCount: ranked.skippedCount,
    exhausted: bestByAgency.length < requestedLimit,
    leads,
  }
}
