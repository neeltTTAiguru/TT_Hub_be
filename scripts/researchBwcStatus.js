/**
 * Answers one question per agency: do they run body-worn cameras?
 *
 * One OpenAI Responses call per agency with the built-in `web_search` tool,
 * forced on so the model cannot answer from memory. One call, one verdict, one
 * citation - the cost per agency is known before the run starts.
 *
 * Deliberately NOT a multi-turn agent. An agent decides for itself how much to
 * search, which is fine for one interactive lookup and ruinous across eleven
 * thousand agencies: the per-agency cost is unknowable until the bill arrives.
 *
 * SAFETY RULES, because a wrong "no" is worse than an unknown:
 *   - Only agencies with no camera status are touched. Nothing established by
 *     the Atlas, LEMAS or a state survey is ever overwritten by this.
 *   - A verdict is discarded unless its citation URL is one the search
 *     actually returned. A model that invents a plausible source gets ignored.
 *   - 'no' requires a source that says so. Finding nothing is 'unknown', which
 *     is a different and honest answer.
 *   - Transient failures do not stamp the agency, so a rate limit or timeout
 *     does not silently retire it from every future run.
 *
 * Usage:
 *   node scripts/researchBwcStatus.js --limit=5 --dry-run
 *   node scripts/researchBwcStatus.js --state=TX --limit=200
 *   node scripts/researchBwcStatus.js --all=true --concurrency=5
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'
const OPENAI_URL = 'https://api.openai.com/v1/responses'

dotenv.config()

const MODEL = process.env.BWC_RESEARCH_MODEL || 'gpt-4.1'
const MAX_TOOL_CALLS = Number(process.env.BWC_RESEARCH_MAX_TOOL_CALLS || 4)
const REQUEST_TIMEOUT_MS = Number(process.env.BWC_RESEARCH_TIMEOUT_MS || 120000)

const parseArgs = () => {
  const args = {}
  for (const raw of process.argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=')
    args[key] = value === undefined ? 'true' : value
  }
  return args
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const callOpenAI = async (body) => {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) {
      throw Object.assign(new Error(text.slice(0, 180)), { statusCode: response.status })
    }
    return JSON.parse(text)
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('web search timed out'), { statusCode: 504 })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const getText = (payload) =>
  (Array.isArray(payload?.output) ? payload.output : [])
    .flatMap((item) =>
      item?.type === 'message' && Array.isArray(item.content)
        ? item.content.filter((c) => c?.type === 'output_text').map((c) => c.text)
        : [],
    )
    .join('\n')
    .trim()

/**
 * Compare citations by host + path only.
 *
 * The URL the model writes into its answer and the one in its citation
 * annotation are frequently the same page with different query strings or
 * tracking parameters, so an exact-string comparison rejects perfectly good
 * sources - it threw out three of three on the first run, including a
 * wilcotx.gov document.
 */
const urlKey = (url) => {
  try {
    const parsed = new URL(String(url))
    return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`
  } catch {
    return ''
  }
}

/** Every URL the model's own citations point at - the check on invented sources. */
const getCitedUrls = (payload) => {
  const urls = new Set()
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of item?.content || []) {
      for (const annotation of content?.annotations || []) {
        if (annotation?.url) urls.add(String(annotation.url))
      }
    }
  }
  return urls
}

const countSearches = (payload) =>
  (Array.isArray(payload?.output) ? payload.output : []).filter(
    (item) => item?.type === 'web_search_call',
  ).length

const RESEARCH_RULES = [
  'You establish whether ONE US law enforcement agency uses body-worn cameras.',
  '',
  'SEARCH FIRST. Never answer from memory. Try more than one phrasing before',
  'concluding nothing exists: "body worn camera", "body cam", "BWC policy", and',
  'the agency name with Axon, WatchGuard or Motorola.',
  '',
  'SOURCE PREFERENCE, strongest first:',
  "1. The agency's own site, or its city/county/state government site (.gov, .us).",
  '2. Council or commissioners-court agendas, minutes and adopted budgets - where',
  '   equipment purchases, vendors and dollar amounts actually appear.',
  '3. State or federal government publications.',
  '4. Established local news.',
  'Social media is weak evidence. Never cite it when an official source says the',
  'same thing. Stop as soon as an authoritative source settles the question.',
  '',
  'VERDICT:',
  'yes  - a source states this agency uses, deploys, purchased, or has a policy for',
  '       body-worn cameras.',
  'no   - a source explicitly states it does NOT use them.',
  'unknown - anything else. Finding nothing is a correct answer: absence of evidence',
  '       is not evidence of absence, and a wrong "no" is worse than an unknown.',
  '',
  'Beware same-named agencies in other states. Confirm the state matches before',
  'using a source.',
  '',
  'Reply with ONE JSON object and nothing else:',
  '{"status":"yes|no|unknown","vendor":"","sourceUrl":"","quote":"","confidence":"high|medium|low"}',
  'sourceUrl must be a page you actually opened. quote is the sentence you relied on.',
].join('\n')

const parseJson = (text) => {
  const raw = String(text || '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  for (const candidate of [fenced?.[1], raw]) {
    if (!candidate) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      /* try next */
    }
  }
  return null
}

/** One call: the model searches, reads, and answers with a citation. */
const researchAgency = async (agency) => {
  const payload = await callOpenAI({
    model: MODEL,
    tools: [{ type: 'web_search' }],
    // 'required', not 'auto': auto lets the model answer from memory, which is
    // exactly the unsourced verdict this must never produce.
    tool_choice: 'required',
    max_tool_calls: MAX_TOOL_CALLS,
    input: [
      { role: 'system', content: RESEARCH_RULES },
      {
        role: 'user',
        content:
          `Agency: ${agency.agencyName}\n` +
          `State: ${agency.stateName || agency.state}\n` +
          `County: ${agency.county || 'n/a'}\n` +
          `${agency.contacts?.website ? `Official website: ${agency.contacts.website}\n` : ''}` +
          '\nDo they use body-worn cameras?',
      },
    ],
  })
  return {
    verdict: parseJson(getText(payload)),
    citedUrls: getCitedUrls(payload),
    searches: countSearches(payload),
  }
}

const run = async () => {
  const args = parseArgs()
  const dryRun = args['dry-run'] === 'true'
  const limit = args.limit ? Number(args.limit) : Infinity
  const concurrency = Math.max(1, Number(args.concurrency || 3))

  if (!args.state && !args.ori && args.all !== 'true') {
    throw new Error('Refusing to run unscoped. Pass --state=XX, --ori=..., or --all=true.')
  }
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI)

  const selector = {
    $and: [
      {
        $or: [
          { 'surveillance.bwc.status': { $exists: false } },
          { 'surveillance.bwc.status': 'unknown' },
        ],
      },
      // Never re-pay for an agency already attempted.
      { $or: [{ 'enrichment.bwcResearchedAt': null }, { 'enrichment.bwcResearchedAt': { $exists: false } }] },
    ],
  }
  if (args.state) selector.state = String(args.state).toUpperCase()
  if (args.ori) selector.ori = String(args.ori).toUpperCase()

  const pending = await LeAgency.find(selector)
    .select('ori agencyName state stateName county contacts.website')
    .sort({ 'employment.swornOfficers': -1 })
    .limit(Number.isFinite(limit) ? limit : 0)
    .lean()

  console.log(`Camera research queue: ${pending.length} agencies`)
  console.log(`  one OpenAI web_search call each, up to ${MAX_TOOL_CALLS} searches per agency`)
  if (dryRun) console.log('  (dry run - searches still run, nothing is written)\n')

  const stats = { yes: 0, no: 0, unknown: 0, failed: 0, retryable: 0, rejected: 0 }
  let done = 0
  let cursor = 0

  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= pending.length) return
      const agency = pending[index]

      let verdict
      let citedUrls
      let searches
      try {
        ;({ verdict, citedUrls, searches } = await researchAgency(agency))
      } catch (error) {
        const status = error?.statusCode
        const transient = status === 429 || status === 408 || status === undefined || status >= 500
        stats.failed += 1
        if (transient) stats.retryable += 1
        console.warn(
          `  ! ${agency.agencyName}: ${String(error.message).slice(0, 90)}` +
            `${transient ? ' [transient - not stamped]' : ''}`,
        )
        if (!dryRun && !transient) {
          await LeAgency.updateOne(
            { ori: agency.ori },
            { $set: { 'enrichment.bwcResearchStatus': 'failed', 'enrichment.bwcResearchedAt': new Date() } },
          )
        }
        continue
      }

      let status = ['yes', 'no'].includes(verdict?.status) ? verdict.status : 'unknown'
      const sourceUrl = String(verdict?.sourceUrl || '').trim()
      // Two guards. A verdict reached without searching is memory, not
      // research. And the cited page must be one the model actually opened -
      // matched on host and path, since query strings differ between the
      // answer text and the annotation. OpenAI also emits internal markers
      // like 'turn0search17' as a URL, which are not sources at all.
      const citedKeys = new Set([...citedUrls].map(urlKey).filter(Boolean))
      const sourceKey = urlKey(sourceUrl)
      if (status !== 'unknown') {
        if (searches === 0) {
          stats.rejected += 1
          status = 'unknown'
        } else if (!sourceKey || (citedKeys.size > 0 && !citedKeys.has(sourceKey))) {
          stats.rejected += 1
          status = 'unknown'
        }
      }

      stats[status] += 1
      done += 1
      const mark = status === 'yes' ? '+' : status === 'no' ? '-' : ' '
      console.log(
        `  ${mark} ${agency.agencyName.slice(0, 34).padEnd(36)}${status.padEnd(8)}` +
          `${String(verdict?.vendor || '').slice(0, 14).padEnd(16)}${sourceUrl.slice(0, 46)}`,
      )

      if (!dryRun) {
        const set = {
          'enrichment.bwcResearchStatus': status === 'unknown' ? 'not-found' : 'ok',
          'enrichment.bwcResearchedAt': new Date(),
        }
        if (status !== 'unknown') {
          set['surveillance.bwc.status'] = status
          set['surveillance.bwc.hasBwc'] = status === 'yes'
          set['surveillance.bwc.evidence'] = 'researched'
          set['surveillance.bwc.asOf'] = new Date()
          set['surveillance.bwc.vendor'] = String(verdict?.vendor || '').trim()
          set['surveillance.bwc.evidenceUrl'] = sourceUrl
          set['surveillance.bwc.summary'] = String(verdict?.quote || '').slice(0, 600)
          set['surveillance.bwc.source'] = 'openai_websearch_research'
          set['surveillance.bwc.importedAt'] = new Date()
        }
        await LeAgency.updateOne({ ori: agency.ori }, { $set: set })
      }

      if (done % 25 === 0) console.log(`  ...${done}/${pending.length}`)
      await sleep(150)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  console.log('\nSummary')
  console.log(`  has cameras      ${stats.yes}`)
  console.log(`  confirmed none   ${stats.no}`)
  console.log(`  still unknown    ${stats.unknown}`)
  console.log(`  citation rejected ${stats.rejected} (URL was not in the search results)`)
  console.log(`  failed           ${stats.failed} (${stats.retryable} transient, will retry)`)

  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
