import Opportunity from '../models/Opportunity.js'
import { ensureBrowserStarted, runBrowserCommand } from './browserResearch.js'

const SAM_GOV_OPPORTUNITIES_URL = 'https://sam.gov/opportunities'
const DEFAULT_KEYWORDS = [
  'body worn camera',
  'body-worn camera',
  'body camera',
  'evidence management',
  'digital evidence',
]
const DEFAULT_NOTICE_TYPES = ['rfp', 'rfq', 'solicitation', 'combined synopsis']
const DEFAULT_BROWSER_SEARCH_TEXT = 'body worn camera'
const MAX_BROWSER_SEARCH_TERMS = 3

const SEARCH_PHRASES = [
  ['bodyworn cameras', 'body worn camera'],
  ['bodyworn camera', 'body worn camera'],
  ['bodyworn', 'body worn camera'],
  ['body-worn camera', 'body worn camera'],
  ['body worn camera', 'body worn camera'],
  ['body cameras', 'body camera'],
  ['body camera', 'body camera'],
  ['bwc', 'BWC'],
  ['digital evidence management', 'digital evidence management'],
  ['evidence management', 'evidence management'],
  ['digital evidence', 'digital evidence'],
  ['law enforcement', 'law enforcement'],
  ['correctional', 'correctional'],
  ['video equipment', 'video equipment'],
  ['audio and video equipment', 'audio video equipment'],
]

const STOP_WORDS = new Set([
  'active',
  'all',
  'any',
  'are',
  'bro',
  'contract',
  'contracting',
  'could',
  'find',
  'from',
  'give',
  'get',
  'has',
  'have',
  'having',
  'hello',
  'hey',
  'inactive',
  'into',
  'load',
  'loaded',
  'look',
  'looking',
  'match',
  'matching',
  'me',
  'need',
  'opportunities',
  'opportunity',
  'page',
  'please',
  'proposal',
  'proposals',
  'quote',
  'quotes',
  'request',
  'requests',
  'rfp',
  'rfps',
  'rfq',
  'rfqs',
  'fpq',
  'fpqs',
  'fq',
  'fqs',
  'rfi',
  'rfis',
  'sam',
  'samgov',
  'search',
  'see',
  'show',
  'solicitation',
  'solicitations',
  'sources',
  'sought',
  'special',
  'notice',
  'the',
  'there',
  'this',
  'with',
  'would',
  'you',
])

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function normalizeInstructionsForSearch(input = '') {
  return compactWhitespace(input)
    .replace(/\bsam\.?gov'?s?\b/gi, 'SAM.gov')
    .replace(/\bbodyworn\b/gi, 'body worn')
    .replace(/\bfpqs\b/gi, 'RFQs')
    .replace(/\bfpq\b/gi, 'RFQ')
    .replace(/\bfqs\b/gi, 'RFQs')
    .replace(/\bfq\b/gi, 'RFQ')
}

function compactBrowserSearchTerms(searchTerms) {
  const phraseTerms = searchTerms.filter((term) => /\s/.test(term))
  const singleTerms = searchTerms.filter((term) => !/\s/.test(term))
  const corePhrase =
    phraseTerms.find((term) => term === 'body worn camera') ||
    phraseTerms.find((term) => term === 'body camera') ||
    phraseTerms[0]

  if (corePhrase) {
    return [corePhrase]
  }

  return uniqueValues([corePhrase, ...singleTerms]).slice(0, MAX_BROWSER_SEARCH_TERMS)
}

export function buildSearchPlan(input = '') {
  const instructions = compactWhitespace(input)
  const normalizedInstructions = normalizeInstructionsForSearch(instructions)
  const lowered = normalizedInstructions.toLowerCase()
  const matchedPhrases = SEARCH_PHRASES
    .filter(([pattern]) => lowered.includes(pattern))
    .map(([, phrase]) => phrase)
  const quotedPhrases = Array.from(normalizedInstructions.matchAll(/"([^"]+)"|'([^']+)'/g))
    .map((match) => compactWhitespace(match[1] || match[2] || ''))
    .filter((phrase) => phrase.length > 2)
  const noticeTypes = uniqueValues([
    /\brfp\b|\brfps\b/i.test(normalizedInstructions) ? 'RFP' : '',
    /\brfq\b|\brfqs\b/i.test(normalizedInstructions) ? 'RFQ' : '',
    /\brfi\b|\brfis\b/i.test(normalizedInstructions) ? 'RFI' : '',
    /\bsources sought\b/i.test(normalizedInstructions) ? 'Sources Sought' : '',
    /\bspecial notice\b/i.test(normalizedInstructions) ? 'Special Notice' : '',
    /\bsolicitation\b|\bsolicitations\b/i.test(normalizedInstructions) ? 'Solicitation' : '',
  ])
  const procurementSearchTerms = noticeTypes
    .filter((noticeType) => ['RFP', 'RFQ', 'RFI'].includes(noticeType))
  const fallbackTerms = lowered
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term) && !/^\d{4}$/.test(term))
    .slice(0, 6)
  const searchTerms = compactBrowserSearchTerms(uniqueValues([...quotedPhrases, ...matchedPhrases, ...procurementSearchTerms]))
  const searchText = searchTerms.length
    ? searchTerms.join(' ')
    : fallbackTerms.length
      ? fallbackTerms.join(' ')
      : DEFAULT_BROWSER_SEARCH_TEXT

  return {
    originalInstructions: instructions,
    normalizedInstructions,
    searchText,
    noticeTypes,
    includeInactive: true,
    keywordMode: 'ANY',
  }
}

function extractRef(snapshot, pattern) {
  const match = String(snapshot || '').match(pattern)
  return match?.[1] || ''
}

function parseDate(value) {
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time)
}

function getPastCutoff(daysBack) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - daysBack)
  cutoff.setHours(0, 0, 0, 0)
  return cutoff
}

function getField(text, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escapedLabel}\\s*([^\\n]+)`, 'i')
  return text.match(pattern)?.[1]?.trim() || ''
}

function getSectionBetween(text, startLabel, endLabels = []) {
  const normalized = String(text || '').replace(/\r/g, '')
  const startIndex = normalized.toLowerCase().indexOf(String(startLabel).toLowerCase())

  if (startIndex === -1) {
    return ''
  }

  const contentStart = startIndex + String(startLabel).length
  const lower = normalized.toLowerCase()
  const endIndex = endLabels
    .map((label) => lower.indexOf(String(label).toLowerCase(), contentStart))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0]

  return normalized
    .slice(contentStart, endIndex === undefined ? undefined : endIndex)
    .replace(/^\s*[:\n]+/, '')
    .trim()
}

function getNoticeId(text) {
  return getField(text, 'Notice ID:')
}

function getNoticeType(text) {
  return getField(text, 'Notice Type')
}

function getAgency(text) {
  return getField(text, 'Department/Ind.Agency')
}

function getOffice(text) {
  return getField(text, 'Office')
}

function getUpdatedDate(text) {
  return getField(text, 'Updated Date')
}

function getPublishedDate(text) {
  return getField(text, 'Published Date')
}

function getResponseDeadline(text) {
  return getField(text, 'Current Response Date') || getField(text, 'Current Date Offers Due')
}

function getStatus(text) {
  if (/\bActive\b/i.test(text) && !/\bInactive\b/i.test(text)) {
    return 'Yes'
  }

  if (/\bInactive\b/i.test(text)) {
    return 'No'
  }

  return ''
}

function isRelevantNoticeType(opportunity, noticeTypes) {
  const haystack = `${opportunity.title} ${opportunity.noticeType} ${opportunity.description}`.toLowerCase()
  return noticeTypes.some((noticeType) => haystack.includes(noticeType.toLowerCase()))
}

function isBodyWornCameraMatch(opportunity) {
  const haystack = `${opportunity.title} ${opportunity.description}`.toLowerCase()
  const normalized = haystack.replace(/[^a-z0-9]+/g, ' ')

  return (
    haystack.includes('body-worn camera') ||
    haystack.includes('body worn camera') ||
    haystack.includes('body cameras') ||
    haystack.includes('body camera') ||
    normalized.includes('bwc') ||
    (normalized.includes('body') && normalized.includes('worn') && normalized.includes('camera'))
  )
}

function isWithinDateWindow(opportunity, cutoff) {
  const updatedAt = parseDate(opportunity.updatedDate)
  const publishedAt = parseDate(opportunity.postedDate)
  return Boolean((updatedAt && updatedAt >= cutoff) || (publishedAt && publishedAt >= cutoff))
}

function normalizeBrowserOpportunity(raw, keyword) {
  const text = String(raw.text || '')
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const noticeId = getNoticeId(text)
  const updatedDate = getUpdatedDate(text)
  const publishedDate = getPublishedDate(text)

  return {
    noticeId: noticeId || String(raw.url || raw.title || ''),
    title: String(raw.title || lines[0] || 'Untitled SAM.gov opportunity'),
    solicitationNumber: noticeId,
    agency: getAgency(text),
    office: getOffice(text),
    postedDate: publishedDate,
    responseDeadline: getResponseDeadline(text),
    noticeType: getNoticeType(text),
    setAside: '',
    naicsCode: '',
    classificationCode: '',
    uiLink: String(raw.url || ''),
    descriptionLink: String(raw.url || ''),
    attachmentLinks: [],
    opportunityLinks: Array.isArray(raw.opportunityLinks) ? raw.opportunityLinks : [],
    sourceKeyword: keyword,
    active: getStatus(text),
    sourceType: 'sam-gov-browser',
    updatedDate,
    description: compactWhitespace(lines.slice(2, 8).join(' ')).slice(0, 600),
  }
}

function buildExtractOpportunityLinksScript() {
  return `() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const sectionHeading = Array.from(document.querySelectorAll('h1,h2,h3,h4,strong,th,div,p'))
      .find((node) => normalize(node.textContent).toLowerCase() === 'attachments/links')

    if (!sectionHeading) {
      return JSON.stringify({ text: '', links: [] })
    }

    let section = sectionHeading.parentElement
    for (let depth = 0; depth < 6 && section; depth += 1) {
      const sectionText = normalize(section.innerText)
      if (/\\bLinks\\b/i.test(sectionText) && /\\bAttachments\\b/i.test(sectionText)) {
        break
      }
      section = section.parentElement
    }

    const links = Array.from((section || sectionHeading.parentElement).querySelectorAll('a[href]'))
      .map((anchor) => {
        const row = anchor.closest('tr') || anchor.parentElement
        const cells = row ? Array.from(row.querySelectorAll('td')).map((cell) => normalize(cell.textContent)) : []
        return {
          label: normalize(anchor.textContent) || anchor.href,
          url: anchor.href,
          updatedDate: cells.find((cell) => /\\b\\w{3}\\s+\\d{1,2},\\s+\\d{4}\\b/.test(cell)) || ''
        }
      })
      .filter((link) => link.label && !/^download all$/i.test(link.label) && !/^request access$/i.test(link.label))

    return JSON.stringify({
      text: normalize((section || sectionHeading.parentElement).innerText),
      links: Array.from(new Map(links.map((link) => [link.url, link])).values())
    })
  }`
}

function buildExtractRfpPackageScript() {
  return `() => {
    const normalize = (value) => (value || '').replace(/\\r/g, '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
    const bodyText = normalize(document.body?.innerText || '')
    const getField = (label) => {
      const escaped = label.replace(/[.*+?^${'${'}()|[\\]\\\\]/g, '\\\\$&')
      const match = bodyText.match(new RegExp(escaped + '\\\\s*\\\\n?([^\\\\n]+)', 'i'))
      return match ? normalize(match[1]) : ''
    }
    const sectionBetween = (startLabel, endLabels) => {
      const lower = bodyText.toLowerCase()
      const start = lower.indexOf(startLabel.toLowerCase())
      if (start === -1) return ''
      const contentStart = start + startLabel.length
      const end = endLabels
        .map((label) => lower.indexOf(label.toLowerCase(), contentStart))
        .filter((index) => index !== -1)
        .sort((a, b) => a - b)[0]
      return normalize(bodyText.slice(contentStart, end === undefined ? undefined : end).replace(/^[:\\s]+/, ''))
    }

    return JSON.stringify({
      classification: getField('Classification'),
      originalSetAside: getField('Original Set Aside'),
      productServiceCode: getField('Product Service Code'),
      naicsCode: getField('NAICS Code'),
      placeOfPerformance: getField('Place of Performance'),
      initiative: getField('Initiative'),
      description: sectionBetween('Description', ['Contact Information', 'Attachments/Links']),
      contactInformation: sectionBetween('Contact Information', ['Contracting Office Address', 'Attachments/Links']),
      primaryPointOfContact: sectionBetween('Primary Point of Contact', ['Alternative Point of Contact', 'Contracting Office Address', 'Attachments/Links']),
      alternativePointOfContact: sectionBetween('Alternative Point of Contact', ['Contracting Office Address', 'Attachments/Links']),
      contractingOfficeAddress: sectionBetween('Contracting Office Address', ['Attachments/Links']),
      attachmentsLinksText: sectionBetween('Attachments/Links', ['History', 'Related Notices']),
      sourceUrl: location.href,
      capturedAt: new Date().toISOString()
    })
  }`
}

function buildParseResultsScript() {
  return `() => {
    const links = Array.from(document.querySelectorAll('a[href*="/workspace/contract/opp/"][href$="/view"]'))
    const seen = new Set()

    return JSON.stringify(links
      .filter((link) => {
        const title = (link.textContent || '').trim()
        if (!title || /^\\(\\d+\\)$/.test(title)) return false
        const href = link.href
        if (seen.has(href)) return false
        seen.add(href)
        return true
      })
      .map((link) => {
        let node = link
        for (let index = 0; index < 8 && node; index += 1) {
          node = node.parentElement
        }

        return {
          title: (link.textContent || '').trim(),
          url: link.href,
          text: node?.innerText || ''
        }
      }))
  }`
}

function buildClickSearchInactiveScript() {
  return `() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => normalize(candidate.textContent) === 'search inactive')

    if (!button) {
      return JSON.stringify({ clicked: false })
    }

    button.click()
    return JSON.stringify({ clicked: true })
  }`
}

function buildSelectAnyWordsScript() {
  return `() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
    const labels = Array.from(document.querySelectorAll('label, div, span'))
    const label = labels.find((candidate) => normalize(candidate.textContent) === 'any words')
    const target = label?.closest('label') || label
    const input = target?.querySelector('input[type="radio"]') || document.querySelector('input[type="radio"][value*="ANY" i]')

    if (input && !input.checked) {
      input.click()
      return JSON.stringify({ selected: true, via: 'input' })
    }

    if (target) {
      target.click()
      return JSON.stringify({ selected: true, via: 'label' })
    }

    return JSON.stringify({ selected: false })
  }`
}

async function searchKeywordInBrowser(keyword, searchPlan = buildSearchPlan(keyword)) {
  await runBrowserCommand(['open', SAM_GOV_OPPORTUNITIES_URL])
  await runBrowserCommand(['wait', '--text', 'Search Contract Opportunities']).catch(() => {})

  const snapshot = await runBrowserCommand(['snapshot', '--limit', '140', '--labels'])
  const textRef = extractRef(snapshot, /textbox "Text Field" \[ref=(e\d+)\]/)
  const searchRef = extractRef(snapshot, /button "Search Domains" \[ref=(e\d+)\]/)
  const activeOnlyRef = extractRef(snapshot, /checkbox "Show active only" \[ref=(e\d+)\] \[checked\]/)

  if (!textRef || !searchRef) {
    const error = new Error('Could not find SAM.gov search controls in the browser.')
    error.statusCode = 502
    throw error
  }

  if (activeOnlyRef) {
    await runBrowserCommand(['click', activeOnlyRef]).catch(() => {})
  }

  await runBrowserCommand(['evaluate', '--fn', buildSelectAnyWordsScript()]).catch(() => '')
  await runBrowserCommand(['type', textRef, searchPlan.searchText])
  await runBrowserCommand(['click', searchRef])
  await runBrowserCommand(['wait', '--text', 'Search Results']).catch(() => {})

  const inactiveClickRaw = await runBrowserCommand(['evaluate', '--fn', buildClickSearchInactiveScript()]).catch(() => '')
  const inactiveClick = inactiveClickRaw ? JSON.parse(JSON.parse(inactiveClickRaw)) : { clicked: false }
  if (inactiveClick.clicked) {
    await runBrowserCommand(['wait', '--text', 'Search Results']).catch(() => {})
  }

  const raw = await runBrowserCommand(['evaluate', '--fn', buildParseResultsScript()])
  const parsed = JSON.parse(JSON.parse(raw))

  return parsed.map((item) => normalizeBrowserOpportunity(item, searchPlan.searchText))
}

async function loadOpportunityDetailLinks(opportunity) {
  if (!opportunity?.uiLink) {
    return opportunity
  }

  await runBrowserCommand(['open', opportunity.uiLink])
  await runBrowserCommand(['wait', '--text', 'Attachments/Links']).catch(() => {})

  const raw = await runBrowserCommand(['evaluate', '--fn', buildExtractOpportunityLinksScript()]).catch(() => '')
  const extracted = raw ? JSON.parse(JSON.parse(raw)) : { text: '', links: [] }
  const packageRaw = await runBrowserCommand(['evaluate', '--fn', buildExtractRfpPackageScript()]).catch(() => '')
  const rfpPackage = packageRaw ? JSON.parse(JSON.parse(packageRaw)) : {}

  return {
    ...opportunity,
    opportunityLinks: Array.isArray(extracted.links) ? extracted.links : [],
    attachmentsLinksText: String(extracted.text || ''),
    rfpPackage,
    naicsCode: rfpPackage.naicsCode || opportunity.naicsCode,
    classificationCode: rfpPackage.productServiceCode || opportunity.classificationCode,
    setAside: rfpPackage.originalSetAside || opportunity.setAside,
    description: rfpPackage.description || opportunity.description,
  }
}

function normalizeExclusionKey(value) {
  return String(value || '').trim().toLowerCase()
}

function isExcludedOpportunity(opportunity, excludedKeys) {
  const keys = [
    opportunity.noticeId,
    opportunity.solicitationNumber,
    opportunity.title,
    opportunity.uiLink,
  ].map(normalizeExclusionKey)

  return keys.some((key) => key && excludedKeys.has(key))
}

export async function findFirstSamGovBrowserOpportunity({ keyword, instructions, excludeNoticeIds = [], save = true } = {}) {
  await ensureBrowserStarted()

  const searchPlan = buildSearchPlan(instructions || keyword || DEFAULT_BROWSER_SEARCH_TEXT)
  const results = await searchKeywordInBrowser(searchPlan.searchText, searchPlan)
  const excludedKeys = new Set((Array.isArray(excludeNoticeIds) ? excludeNoticeIds : []).map(normalizeExclusionKey))
  const availableResults = results.filter((opportunity) => !isExcludedOpportunity(opportunity, excludedKeys))
  const firstMatch = availableResults.find(isBodyWornCameraMatch) || availableResults[0] || null

  if (!firstMatch) {
    return {
      source: 'sam-gov-browser',
      searchUrl: SAM_GOV_OPPORTUNITIES_URL,
      keyword: searchPlan.searchText,
      searchPlan,
      opportunity: null,
      scannedAt: new Date().toISOString(),
    }
  }

  const enrichedMatch = await loadOpportunityDetailLinks(firstMatch)

  const opportunity = save
    ? await Opportunity.findOneAndUpdate({ noticeId: enrichedMatch.noticeId }, enrichedMatch, {
        upsert: true,
        new: true,
        runValidators: true,
      })
    : enrichedMatch

  return {
    source: 'sam-gov-browser',
    searchUrl: SAM_GOV_OPPORTUNITIES_URL,
    keyword: searchPlan.searchText,
    searchPlan,
    opportunity,
    scannedAt: new Date().toISOString(),
  }
}

async function saveBrowserOpportunities(opportunities) {
  return Promise.all(
    opportunities.map((opportunity) =>
      Opportunity.findOneAndUpdate({ noticeId: opportunity.noticeId }, opportunity, {
        upsert: true,
        new: true,
        runValidators: true,
      }),
    ),
  )
}

export async function runSamGovBrowserSearch({
  keywords = DEFAULT_KEYWORDS,
  daysBack = 21,
  noticeTypes = DEFAULT_NOTICE_TYPES,
  save = true,
} = {}) {
  await ensureBrowserStarted()

  const cutoff = getPastCutoff(daysBack)
  const keywordResults = []

  for (const keyword of keywords) {
    const results = await searchKeywordInBrowser(keyword)
    keywordResults.push(...results)
  }

  const deduped = Array.from(new Map(keywordResults.map((opportunity) => [opportunity.noticeId, opportunity])).values())
  const filtered = deduped
    .filter((opportunity) => isWithinDateWindow(opportunity, cutoff))
    .filter(isBodyWornCameraMatch)
    .filter((opportunity) => isRelevantNoticeType(opportunity, noticeTypes))
    .sort((left, right) => String(right.updatedDate || right.postedDate).localeCompare(String(left.updatedDate || left.postedDate)))

  const opportunities = save ? await saveBrowserOpportunities(filtered) : filtered

  return {
    source: 'sam-gov-browser',
    searchUrl: SAM_GOV_OPPORTUNITIES_URL,
    daysBack,
    keywords,
    noticeTypes,
    opportunities,
    scannedAt: new Date().toISOString(),
  }
}
