// Per-agency "newsroom" briefing.
//
// Two halves, deliberately kept apart:
//   facts    - straight from our own database. Never model-generated.
//   research - found on the web via the Responses API `web_search` tool, with a
//              source URL attached to every claim.
//
// The split matters because the interesting questions here (does this
// department run body cameras? whose? what is their budget cycle?) are exactly
// the ones a language model will happily invent. Anything unsourced comes back
// empty rather than plausible.

import LeAgency from '../models/LeAgency.js'
import AgencyBriefing from '../models/AgencyBriefing.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
// gpt-4.1-mini returns ~2 citations per search; gpt-4.1 returns ~12 for the
// same query and costs a few seconds more. gpt-5 searches far more thoroughly
// but takes over two minutes, which is too slow for a click-through panel.
// So: gpt-4.1 for the researching calls, and the cheap model for the writeup,
// which does no searching of its own.
const DEFAULT_MODEL = process.env.AGENCY_BRIEFING_MODEL || 'gpt-4.1'
const SYNTHESIS_MODEL =
  process.env.AGENCY_BRIEFING_SYNTHESIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini'
const REQUEST_TIMEOUT_MS = Number(process.env.AGENCY_BRIEFING_TIMEOUT_MS || 120000)
const MAX_TOOL_CALLS = Number(process.env.AGENCY_BRIEFING_MAX_TOOL_CALLS || 14)
// Agency circumstances move slowly; a fortnight-old briefing is still useful.
const CACHE_MAX_AGE_MS = Number(process.env.AGENCY_BRIEFING_MAX_AGE_MS || 14 * 24 * 60 * 60 * 1000)

const sourcedItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: 'One sentence, stating only what the source says.' },
    url: { type: 'string', description: 'Exact URL this came from. Empty string if none.' },
    date: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM if stated, else empty string.' },
  },
  required: ['text', 'url', 'date'],
}

function getTextFromResponse(payload) {
  if (!Array.isArray(payload?.output)) return ''
  return payload.output
    .flatMap((item) => {
      if (item?.type !== 'message' || !Array.isArray(item.content)) return []
      return item.content
        .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text)
    })
    .join('\n')
    .trim()
}

function getCitedUrls(payload) {
  const urls = new Set()
  if (!Array.isArray(payload?.output)) return []
  for (const item of payload.output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const content of item.content) {
      for (const annotation of content?.annotations || []) {
        if (annotation?.type === 'url_citation' && annotation.url) {
          urls.add(String(annotation.url).split('#')[0])
        }
      }
    }
  }
  return [...urls]
}

/**
 * Everything we already know, straight from the database.
 *
 * Population is derived from the FBI's own employees-per-1,000 rate rather than
 * looked up separately, so it always agrees with the headcount beside it.
 */
export function buildFacts(agency) {
  const employment = agency.employment || {}
  const history = Array.isArray(agency.employmentHistory) ? agency.employmentHistory : []

  let populationServed = null
  if (employment.employeesPer1000 > 0 && employment.totalEmployees > 0) {
    populationServed = Math.round((employment.totalEmployees / employment.employeesPer1000) * 1000)
  }

  const withCounts = history.filter((row) => typeof row.swornOfficers === 'number')
  const first = withCounts[0]
  const last = withCounts[withCounts.length - 1]
  let trend = null
  if (first && last && first.year !== last.year) {
    trend = {
      fromYear: first.year,
      toYear: last.year,
      fromOfficers: first.swornOfficers,
      toOfficers: last.swornOfficers,
      change: last.swornOfficers - first.swornOfficers,
    }
  }

  return {
    ori: agency.ori,
    agencyName: agency.agencyName,
    agencyType: agency.agencyType,
    state: agency.state,
    county: agency.county,
    swornOfficers: employment.swornOfficers ?? null,
    civilians: employment.civilians ?? null,
    totalEmployees: employment.totalEmployees ?? null,
    dataYear: employment.dataYear ?? null,
    populationServed,
    trend,
    isNibrs: Boolean(agency.isNibrs),
    crm: agency.crm?.matched
      ? {
          stage: agency.crm.stage,
          dealCount: agency.crm.dealCount,
          owner: agency.crm.owner,
        }
      : null,
  }
}

async function callOpenAI(body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text()
      throw Object.assign(new Error(text || `OpenAI request failed with ${response.status}`), {
        statusCode: response.status,
      })
    }
    return response.json()
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Agency research timed out while searching the web.'), {
        statusCode: 504,
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function getAgencyBriefing(ori, { refresh = false } = {}) {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() }).lean()
  if (!agency) {
    throw Object.assign(new Error('Agency was not found.'), { statusCode: 404 })
  }

  const facts = buildFacts(agency)
  const existing = await AgencyBriefing.findOne({ ori: facts.ori }).lean()

  if (!refresh && existing?.generatedAt) {
    const age = Date.now() - new Date(existing.generatedAt).getTime()
    if (age < CACHE_MAX_AGE_MS) {
      return { ...existing, facts, cached: true }
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('OPENAI_API_KEY is not configured on the backend.'), {
      statusCode: 503,
    })
  }

  const where = [facts.agencyName, facts.county ? `${facts.county} County` : '', facts.state]
    .filter(Boolean)
    .join(', ')

  const startedAt = Date.now()

  const ACCURACY_RULES = [
    'ACCURACY RULES, these override everything else:',
    '1. Report only what you actually read on a page you opened. Never infer or extrapolate from what similar agencies typically do.',
    '2. Every non-empty claim must carry the exact URL you read it on. If you cannot cite it, return an empty string or an empty array.',
    '3. Beware of same-named agencies elsewhere. Confirm the state and county match before using a source.',
    '4. Finding nothing is a correct and useful answer. Say so plainly instead of filling the gap.',
  ].join(' ')

  const agencyLine = [
    `Agency: ${facts.agencyName}`,
    `Location: ${where}`,
    facts.agencyType ? `Type: ${facts.agencyType}` : '',
    facts.swornOfficers !== null ? `Size: ${facts.swornOfficers} sworn officers` : '',
  ]
    .filter(Boolean)
    .join('\n')

  /** One focused researcher per topic, each with its own schema and searches. */
  const researchTopic = async ({ name, schema, instruction }) => {
    const payload = await callOpenAI({
      model: DEFAULT_MODEL,
      tools: [{ type: 'web_search' }],
      // 'auto' lets the model skip searching and answer from memory, which is
      // exactly the unsourced output this feature must not produce.
      tool_choice: 'required',
      max_tool_calls: MAX_TOOL_CALLS,
      text: { format: { type: 'json_schema', name, strict: true, schema } },
      input: [
        {
          role: 'system',
          content: `You research US law enforcement agencies for a body-worn camera vendor. ${ACCURACY_RULES}`,
        },
        { role: 'user', content: `${agencyLine}\n\n${instruction}` },
      ],
    })

    let parsed = null
    try {
      parsed = JSON.parse(getTextFromResponse(payload))
    } catch {
      parsed = null
    }
    return {
      topic: name,
      parsed,
      urls: getCitedUrls(payload),
      searches: Array.isArray(payload?.output)
        ? payload.output.filter((item) => item?.type === 'web_search_call').length
        : 0,
      error: '',
    }
  }

  const TOPICS = [
    {
      name: 'bwc_status',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hasProgram: { type: 'string', enum: ['yes', 'no', 'unknown'] },
          vendor: { type: 'string' },
          details: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['hasProgram', 'vendor', 'details', 'confidence'],
      },
      instruction: [
        'Do they run body-worn cameras, and with which vendor?',
        'Search their official site, local news, and council or commission minutes.',
        'Set hasProgram to "yes" or "no" only if a source states it plainly, otherwise "unknown".',
        'Never name a vendor unless a source names that vendor for THIS agency. A vendor used by a neighbouring department is not evidence.',
      ].join(' '),
    },
    {
      name: 'budget_status',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          fiscalYear: { type: 'string' },
          signals: { type: 'array', items: sourcedItem },
        },
        required: ['summary', 'fiscalYear', 'signals'],
      },
      instruction: [
        'What is their budget position? Search the city or county budget documents and council or commission minutes.',
        'Capture the police budget figure and fiscal year if published, plus any votes, approvals or line items touching equipment, technology or cameras.',
      ].join(' '),
    },
    {
      name: 'grant_awards',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { items: { type: 'array', items: sourcedItem } },
        required: ['items'],
      },
      instruction:
        'What grants has this agency received? Search federal, state and foundation award listings (JAG/Byrne, COPS, state public-safety grants). Include the award amount and year where stated.',
    },
    {
      name: 'recent_news',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { items: { type: 'array', items: sourcedItem } },
        required: ['items'],
      },
      instruction:
        'What has been in the news about this agency in the last two years? Prioritise leadership changes, transparency or accountability matters, technology purchases, staffing, and funding. Newest first.',
    },
  ]

  // Run the four topics concurrently: coverage is guaranteed by orchestration
  // rather than by hoping one prompt triggers enough tool calls.
  const settled = await Promise.all(
    TOPICS.map((topic) =>
      researchTopic(topic).catch((error) => ({
        topic: topic.name,
        parsed: null,
        urls: [],
        searches: 0,
        error: String(error?.message || error).slice(0, 200),
      })),
    ),
  )
  for (const result of settled) {
    if (!result.error && result.searches === 0) {
      result.parsed = null
      result.error = 'answered without searching; discarded'
    }
  }
  const failedTopics = settled.filter((r) => r.error).map((r) => `${r.topic}: ${r.error}`)
  if (process.env.AGENCY_BRIEFING_DEBUG === 'true') {
    for (const r of settled) {
      console.log(`[briefing] ${r.topic.padEnd(14)} searches=${r.searches} urls=${r.urls.length} ${r.error ? 'ERROR ' + r.error : ''}`)
    }
  }
  const [bwcRes, budgetRes, grantRes, newsRes] = settled

  const searchCount = settled.reduce((sum, r) => sum + r.searches, 0)
  const sources = [...new Set(settled.flatMap((r) => r.urls))]

  const cleanList = (items) =>
    (Array.isArray(items) ? items : [])
      .filter((item) => String(item?.text || '').trim())
      .map((item) => ({
        text: String(item.text).trim(),
        url: String(item.url || '').trim(),
        date: String(item.date || '').trim(),
      }))
      .slice(0, 12)

  const bwcStatus = {
    hasProgram: ['yes', 'no', 'unknown'].includes(bwcRes.parsed?.hasProgram)
      ? bwcRes.parsed.hasProgram
      : 'unknown',
    vendor: String(bwcRes.parsed?.vendor || '').trim(),
    details: String(bwcRes.parsed?.details || '').trim(),
    confidence: ['high', 'medium', 'low'].includes(bwcRes.parsed?.confidence)
      ? bwcRes.parsed.confidence
      : 'low',
  }
  const budget = {
    summary: String(budgetRes.parsed?.summary || '').trim(),
    fiscalYear: String(budgetRes.parsed?.fiscalYear || '').trim(),
    signals: cleanList(budgetRes.parsed?.signals),
  }
  const grants = cleanList(grantRes.parsed?.items)
  const news = cleanList(newsRes.parsed?.items)

  // Writeup only. No tools, so it cannot introduce anything unsourced.
  let summary = ''
  let outreachAngle = ''
  let openQuestions = []
  try {
    const writeup = await callOpenAI({
      model: SYNTHESIS_MODEL,
      text: {
        format: {
          type: 'json_schema',
          name: 'briefing_writeup',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
              outreachAngle: { type: 'string' },
              openQuestions: { type: 'array', items: { type: 'string' } },
            },
            required: ['summary', 'outreachAngle', 'openQuestions'],
          },
        },
      },
      input: [
        {
          role: 'system',
          content:
            'You brief a salesperson before a call. Use ONLY the findings supplied. Never add facts, vendors, figures or events that are not in them. Where the findings are empty, say plainly that it is unknown and put it in openQuestions. Write plainly and briefly.',
        },
        {
          role: 'user',
          content: [
            agencyLine,
            facts.populationServed ? `Population served: about ${facts.populationServed.toLocaleString()}` : '',
            facts.trend
              ? `Headcount ${facts.trend.fromYear}-${facts.trend.toYear}: ${facts.trend.fromOfficers} to ${facts.trend.toOfficers} sworn`
              : '',
            facts.crm ? `Already in our pipeline at stage: ${facts.crm.stage}` : 'Not yet contacted.',
            '',
            'FINDINGS:',
            JSON.stringify({ bwcStatus, budget, grants, news }, null, 1),
            '',
            'Write a 2-3 sentence summary, a grounded outreach angle, and the open questions worth asking directly.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    })
    const parsedWriteup = JSON.parse(getTextFromResponse(writeup))
    summary = String(parsedWriteup?.summary || '').trim()
    outreachAngle = String(parsedWriteup?.outreachAngle || '').trim()
    openQuestions = (Array.isArray(parsedWriteup?.openQuestions) ? parsedWriteup.openQuestions : [])
      .map((q) => String(q).trim())
      .filter(Boolean)
      .slice(0, 8)
  } catch {
    summary = ''
  }

  const research = { summary, bwcStatus, budget, grants, news, outreachAngle, openQuestions }
  // Surfaced so the UI never presents a partial briefing as a complete one.
  research.failedTopics = failedTopics

  for (const item of [...budget.signals, ...grants, ...news]) {
    if (item.url) sources.push(String(item.url).split('#')[0])
  }
  const allSources = [...new Set(sources)]

  const doc = {
    ori: facts.ori,
    agencyName: facts.agencyName,
    facts,
    research,
    sources: allSources,
    model: DEFAULT_MODEL,
    searchCount,
    generatedAt: new Date(),
    durationMs: Date.now() - startedAt,
  }

  await AgencyBriefing.updateOne({ ori: facts.ori }, { $set: doc }, { upsert: true })
  return { ...doc, cached: false }
}
