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
import { chatWithHermes } from './hermesChat.js'

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
// 'hermes' researches through the Hermes gateway, which reaches Firecrawl and
// so can open the agency's own site rather than reading search snippets.
// 'openai' is the original Responses-API path, kept as a one-env-var fallback
// because Hermes is a second moving part that can be down independently.
const RESEARCH_BACKEND = (process.env.AGENCY_BRIEFING_BACKEND || 'hermes').toLowerCase()
const HERMES_AGENT_ID = process.env.AGENCY_BRIEFING_HERMES_AGENT || 'trusted-tech-assistant'
// A tool-calling turn through Hermes runs far longer than a Responses call.
// Hermes turn latency is highly variable rather than uniformly slow: measured
// at 23s, 23s, 27s and 104s for four identical concurrent calls. A straggler is
// bad luck, not a doomed request, so a timed-out topic is retried once - which
// is far cheaper than raising the ceiling high enough to wait out the worst
// case on every topic.
const HERMES_TOPIC_TIMEOUT_MS = Number(process.env.AGENCY_BRIEFING_HERMES_TIMEOUT_MS || 300000)
const HERMES_TOPIC_RETRIES = Number(process.env.AGENCY_BRIEFING_HERMES_RETRIES || 1)
// The writeup does no searching, so it needs far less room than a research turn.
const HERMES_WRITEUP_TIMEOUT_MS = Number(process.env.AGENCY_BRIEFING_HERMES_WRITEUP_TIMEOUT_MS || 90000)
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

/**
 * Hermes returns prose, not a schema-validated object, so the JSON has to be
 * dug out of whatever the model wrapped it in - a fenced block, or a sentence
 * either side of it. Returns null rather than throwing: a topic that cannot be
 * parsed is dropped, exactly like one that came back uncited.
 */
function parseLooseJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], raw]
  for (const candidate of candidates) {
    if (!candidate) continue
    const trimmed = candidate.trim()
    const start = trimmed.search(/[[{]/)
    if (start === -1) continue
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (end <= start) continue
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/**
 * Every URL the model put inside its own answer.
 *
 * The OpenAI path gets citations from response annotations; Hermes has no
 * equivalent, so the answer's own url fields are the only evidence that a page
 * was actually opened. That makes this the Hermes stand-in for the
 * "answered without searching" guard - no URLs means the claim is discarded.
 */
function harvestUrls(value, found = new Set()) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value.trim())) found.add(value.trim())
  } else if (Array.isArray(value)) {
    for (const entry of value) harvestUrls(entry, found)
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) harvestUrls(entry, found)
  }
  return [...found]
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
    // The researcher was searching blind for pages we already hold. Handing it
    // the agency's own site turns a guess about which domain is authoritative
    // into a known starting point.
    website: agency.contacts?.website || '',
    // What the Atlas of Surveillance already records. Passed in so the camera
    // question starts from a cited fact and the research verifies or updates
    // it, instead of re-deriving from scratch and often finding nothing.
    knownBwc: agency.surveillance?.bwc?.hasBwc
      ? {
          vendor: agency.surveillance.bwc.vendor || '',
          evidenceUrl: agency.surveillance.bwc.evidenceUrl || '',
          evidenceDate: agency.surveillance.bwc.evidenceDate || null,
        }
      : null,
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

  // Only the OpenAI research path needs the key up front. In Hermes mode the
  // sole remaining OpenAI call is the writeup, which is already wrapped in a
  // try/catch - so a missing key costs the summary paragraph, not the briefing.
  if (RESEARCH_BACKEND !== 'hermes' && !process.env.OPENAI_API_KEY) {
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
    // Known starting points, so the researcher does not have to guess which
    // domain is authoritative or rediscover what we already hold.
    facts.website ? `Official website (start here): ${facts.website}` : '',
    facts.county ? `County government site is likely to hold the budget and commissioners' court minutes.` : '',
    facts.knownBwc
      ? `ALREADY ON RECORD - the Atlas of Surveillance documented body-worn cameras here${
          facts.knownBwc.vendor ? `, vendor ${facts.knownBwc.vendor}` : ' (vendor not published)'
        }${
          facts.knownBwc.evidenceDate
            ? ` as of ${new Date(facts.knownBwc.evidenceDate).getFullYear()}`
            : ''
        }. Source: ${facts.knownBwc.evidenceUrl}. Confirm whether this is still current and find the vendor if it is not named.`
      : '',
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

  /**
   * Same contract as researchTopic, but researched through Hermes so the model
   * can use Firecrawl to open the agency's own website instead of ranking
   * search snippets. Hermes speaks plain chat completions - there is no strict
   * json_schema and no tool_choice:'required' - so the schema is stated in the
   * prompt and the result is validated on the way out instead of on the way in.
   */
  const researchTopicViaHermes = async (topic) => {
    let lastError
    for (let attempt = 0; attempt <= HERMES_TOPIC_RETRIES; attempt += 1) {
      try {
        return await researchTopicViaHermesOnce(topic)
      } catch (error) {
        lastError = error
        const message = String(error?.message || error)
        // Only a slow turn is worth repeating; a refusal or a bad request will
        // fail again identically and would just double the wait.
        const worthRetrying = /too long|timeout|timed out|abort/i.test(message)
        if (!worthRetrying || attempt === HERMES_TOPIC_RETRIES) throw error
        console.warn(`[briefing] ${topic.name} timed out, retrying once`)
      }
    }
    throw lastError
  }

  const researchTopicViaHermesOnce = async ({ name, schema, instruction }) => {
    const instructions = [
      'You research US law enforcement agencies for a body-worn camera vendor.',
      ACCURACY_RULES,
      '',
      'HOW TO RESEARCH:',
      '- Use firecrawl_search to find pages, then firecrawl_scrape to READ the ones that matter.',
      "- Prefer the agency's own website over news coverage, and news coverage over aggregators.",
      '- A search result snippet is NOT a source. Open the page before citing it.',
      '- Work the sources in this order: the agency or county official site, then',
      '  commissioners-court or city-council agendas and minutes, then adopted budget',
      '  PDFs, then local news. Minutes and agendas are where equipment purchases,',
      '  vendors and dollar amounts actually appear - search them explicitly.',
      '- Try more than one phrasing before concluding nothing exists. For cameras,',
      '  search "body-worn camera", "body cam", "axon", "watchguard" and the agency name.',
      '- Budget: up to 6 searches and 10 page reads. Use them; a thin answer from two',
      '  searches is worse than a slower, sourced one.',
      '- Only stop early if you have answered the question with a citation.',
      '',
      'HOW TO ANSWER:',
      `Reply with ONE JSON object matching this schema and NOTHING else - no prose, no code fence:`,
      JSON.stringify(schema),
      'Every url field must be a page you actually opened. If you did not open a page for a claim, omit the claim.',
      'An empty answer is correct when nothing citable exists. Never fill a gap with a guess.',
    ].join('\n')

    const response = await chatWithHermes(
      HERMES_AGENT_ID,
      [{ role: 'user', content: `${agencyLine}\n\n${instruction}` }],
      {
        instructions,
        memoryContext: '',
        timeoutMs: HERMES_TOPIC_TIMEOUT_MS,
        rateLimitRetries: 1,
      },
    )

    const parsed = parseLooseJson(response?.message?.content)
    const urls = parsed ? harvestUrls(parsed) : []
    return {
      topic: name,
      parsed,
      urls,
      // Stands in for the OpenAI search count: the existing guard below drops
      // any topic reporting zero, which here means nothing was cited.
      searches: urls.length,
      error: parsed ? '' : 'hermes returned no parseable JSON',
    }
  }

  const runTopic = RESEARCH_BACKEND === 'hermes' ? researchTopicViaHermes : researchTopic

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
      runTopic(topic).catch((error) => ({
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
      result.error =
        RESEARCH_BACKEND === 'hermes'
          ? 'answered without citing a page it opened; discarded'
          : 'answered without searching; discarded'
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

  // Writeup only. It is handed the findings and given no tools, so it cannot
  // introduce anything the research did not already source.
  let summary = ''
  let outreachAngle = ''
  let openQuestions = []
  try {
    const writeupSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string' },
        outreachAngle: { type: 'string' },
        openQuestions: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'outreachAngle', 'openQuestions'],
    }
    const writeupSystem =
      'You brief a salesperson before a call. Use ONLY the findings supplied. Never add facts, vendors, figures or events that are not in them. Where the findings are empty, say plainly that it is unknown and put it in openQuestions. Write plainly and briefly.'
    const writeupUser = [
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
      .join('\n')

    let parsedWriteup
    if (RESEARCH_BACKEND === 'hermes') {
      // No searching here, so the model is told explicitly not to reach for a
      // tool: the whole point of this step is that it cannot add anything the
      // research did not already cite.
      const response = await chatWithHermes(
        HERMES_AGENT_ID,
        [{ role: 'user', content: writeupUser }],
        {
          instructions: [
            writeupSystem,
            'Do NOT call any tool. Do not search. Work only from the findings given to you.',
            'Reply with ONE JSON object matching this schema and NOTHING else - no prose, no code fence:',
            JSON.stringify(writeupSchema),
          ].join('\n'),
          memoryContext: '',
          timeoutMs: HERMES_WRITEUP_TIMEOUT_MS,
          rateLimitRetries: 1,
        },
      )
      parsedWriteup = parseLooseJson(response?.message?.content)
    } else {
      const writeup = await callOpenAI({
        model: SYNTHESIS_MODEL,
        text: { format: { type: 'json_schema', name: 'briefing_writeup', strict: true, schema: writeupSchema } },
        input: [
          { role: 'system', content: writeupSystem },
          { role: 'user', content: writeupUser },
        ],
      })
      parsedWriteup = JSON.parse(getTextFromResponse(writeup))
    }
    summary = String(parsedWriteup?.summary || '').trim()
    outreachAngle = String(parsedWriteup?.outreachAngle || '').trim()
    openQuestions = (Array.isArray(parsedWriteup?.openQuestions) ? parsedWriteup.openQuestions : [])
      .map((q) => String(q).trim())
      .filter(Boolean)
      .slice(0, 8)
  } catch (error) {
    // Swallowed on purpose - the briefing is still useful without a writeup -
    // but never silently: an empty summary with no log is undiagnosable.
    console.warn('[briefing] writeup failed:', String(error?.message || error).slice(0, 200))
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
    // What actually produced this briefing, so a stored doc is never mistaken
    // for one researched by a different backend.
    model: RESEARCH_BACKEND === 'hermes' ? `hermes:${HERMES_AGENT_ID}` : DEFAULT_MODEL,
    searchCount,
    generatedAt: new Date(),
    durationMs: Date.now() - startedAt,
  }

  await AgencyBriefing.updateOne({ ori: facts.ori }, { $set: doc }, { upsert: true })
  return { ...doc, cached: false }
}
