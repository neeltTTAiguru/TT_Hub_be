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

// A reasoning model, and not a preference: gpt-4.1 treats web_search as a
// single lookup - one call, one query, one source - which makes the whole
// multi-phase search discipline below unenforceable. On the same prompt gpt-5
// ran 9 searches over 114 sources, working the agency site, vendor contracts,
// the adopted budget, released footage and cooperative purchasing in turn.
// With gpt-4.1 both Tarrant and Harris County came back "planned" off a single
// budget line; both run deployed programmes.
const MODEL = process.env.BWC_RESEARCH_MODEL || 'gpt-5'
// Low is enough: the work is searching and reading, not reasoning, and higher
// effort mostly buys latency here.
const REASONING_EFFORT = process.env.BWC_RESEARCH_EFFORT || 'low'
// Must exceed the search minimums the prompt sets (5 small, 8 larger) or the
// instruction is unfollowable: capped at 4, it used ONE search and returned
// "planned" for Tarrant and Harris County sheriffs on the strength of a budget
// line, when both plainly run deployed programmes.
const MAX_TOOL_CALLS = Number(process.env.BWC_RESEARCH_MAX_TOOL_CALLS || 12)
// Nine searches take about a minute, so the ceiling has to clear that with room
// for a slow one rather than cutting good research off mid-way.
const REQUEST_TIMEOUT_MS = Number(process.env.BWC_RESEARCH_TIMEOUT_MS || 300000)

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

/**
 * Every URL the model actually consulted - annotations plus the full source
 * list returned by `include: ['web_search_call.action.sources']`. This is the
 * allowlist a verdict's citation has to appear in.
 */
const getCitedUrls = (payload) => {
  const urls = new Set()
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of item?.content || []) {
      for (const annotation of content?.annotations || []) {
        if (annotation?.url) urls.add(String(annotation.url))
      }
    }
    for (const source of item?.action?.sources || []) {
      const url = typeof source === 'string' ? source : source?.url
      if (url) urls.add(String(url))
    }
  }
  return urls
}

const countSearches = (payload) =>
  (Array.isArray(payload?.output) ? payload.output : []).filter(
    (item) => item?.type === 'web_search_call',
  ).length

/**
 * Phase 0 is already done for us, and that is the point.
 *
 * The generic version of this process opens by researching the agency's legal
 * name, ORI, type, headcount and jurisdiction. We hold all of that, plus the
 * official website and whatever the Atlas already recorded. Handing it over
 * instead of re-deriving it saves several searches per agency and, more
 * importantly, stops the model resolving the agency wrongly and then
 * confidently researching a different department.
 */
const agencyBrief = (agency, regime) =>
  [
    `Agency: ${agency.agencyName}`,
    `ORI: ${agency.ori}`,
    `State: ${agency.stateName || agency.state}`,
    agency.county ? `County: ${agency.county}` : '',
    agency.agencyType ? `Type: ${agency.agencyType}` : '',
    agency.employment?.swornOfficers != null
      ? `Sworn officers: ${agency.employment.swornOfficers}`
      : 'Sworn officers: not reported',
    agency.contacts?.website ? `Official website: ${agency.contacts.website}` : '',
    agency.surveillance?.bwc?.hasBwc
      ? `ALREADY ON RECORD: ${agency.surveillance.bwc.source} reported cameras${
          agency.surveillance.bwc.vendor ? ` (${agency.surveillance.bwc.vendor})` : ''
        }${
          agency.surveillance.bwc.asOf
            ? ` as of ${new Date(agency.surveillance.bwc.asOf).getFullYear()}`
            : ''
        }. Confirm whether it still holds and find the contract term.`
      : '',
    regime ? `State BWC legal regime, already established: ${regime}` : '',
  ]
    .filter(Boolean)
    .join('\n')

const RESEARCH_RULES = [
  'You determine whether ONE named law enforcement agency operates body-worn',
  'cameras. You have web search. You output JSON only.',
  '',
  'CORE RULE: "no evidence found" is NOT "no cameras". The default is unknown.',
  'Only answer "no" on an explicit agency statement, or a public-records response',
  'showing no BWC policy or purchase exists. Breaking this rule is the worst error',
  'you can make - a wrong "no" sends a rep to an agency that already bought, and',
  'removes a real prospect from the list.',
  '',
  'The agency is already resolved for you: name, ORI, state, type, headcount and',
  'website are given. Do not re-derive them. Do rule out similarly named agencies',
  'nearby - a city PD, county sheriff, constable, campus PD and ISD PD in the same',
  'geography are different agencies and different buyers. Add exclusion terms.',
  '',
  'SEARCH IN THIS ORDER, stopping when a primary document settles it:',
  '1. The agency or jurisdiction site: policy, transparency and records pages,',
  '   hosted policy manuals ("<agency>" powerdms / "<agency>" lexipol).',
  '2. THE MONEY TRAIL - the most reliable evidence there is, so do not skip it',
  '   even if step 1 hit. Council or commissioners-court agendas and minutes name',
  '   the vendor and the amount verbatim. Also adopted budgets and CIP documents,',
  '   cooperative contracts (BuyBoard, Sourcewell, HGACBuy, NASPO, TIPS), state',
  '   grant administrator awards, and BJA grant lists.',
  '3. Released footage. "<agency>" "body camera footage" released is strong proof',
  '   a programme is running.',
  '4. Local news and vendor press releases (Axon, Motorola/WatchGuard, Getac,',
  '   Utility, Digital Ally, Reveal, Visual Labs) - corroborate before trusting.',
  '',
  'SMALL AGENCIES: under 25 sworn officers, online sources routinely fail even',
  'when cameras exist. Do not read that silence as "no". Return unknown and set',
  'nextAction to a records request or a phone call.',
  '',
  'DO NOT BLUR THESE:',
  '- in-car and dash cameras are NOT body-worn cameras',
  '- fixed jail and interview-room cameras are NOT body-worn cameras',
  '- a state mandate is NOT evidence this agency complies with it',
  '- a pilot is NOT a deployment',
  '',
  'VARY YOUR QUERIES. Repeating one returns the same results. Run at least 5',
  'distinct searches before returning unknown, and at least 8 for an agency over',
  '25 sworn officers.',
  '',
  'STATUS - pick exactly one:',
  'yes                    - a primary document shows an operating programme.',
  'purchased_not_deployed - contract, purchase order, budget line or grant award,',
  '                         with no evidence it is in use yet.',
  'planned                - budgeted, applied for, or publicly committed only.',
  'no                     - explicit statement of non-use, or a nil records',
  '                         response. Nothing else qualifies.',
  'unknown                - the default, and a correct answer.',
  '',
  'confidence: high only for a primary document within the last 24 months.',
  'medium for older but uncontradicted evidence. low for anything thinner.',
  '',
  'contractEnd matters more than almost anything else you can find: a term',
  'expiring soon is a dated reason to make contact. Populate it whenever a source',
  'gives a period of performance or contract term. Format YYYY-MM-DD.',
  '',
  'Reply with ONE JSON object and nothing else:',
  '{"status":"yes|no|planned|purchased_not_deployed|unknown","vendor":"",',
  ' "cameraCount":null,"contractEnd":"","confidence":"high|medium|low",',
  ' "sourceUrl":"","quote":"","collisionsRuledOut":"","nextAction":"",',
  ' "stateRegime":"A_use_mandate|B_policy_if_operating|C_funding_conditioned|D_no_law|unclear"}',
  '',
  'sourceUrl MUST be a complete URL starting with https://, copied from a page you',
  'actually opened. NEVER a document title or citation label. quote is the exact',
  'sentence supporting the claim. If you cannot attach a URL, the status is',
  'unknown.',
  '',
  'stateRegime: classify how this state legislates BWCs, from the statute or the',
  'NCSL database - not from a "body camera laws by state" listicle, which conflate',
  '"has legislation" with "mandates cameras" and are routinely overinclusive.',
  'A = officers must wear them. B = an agency that operates them must have a',
  'written policy, so absence of a policy IS meaningful. C = policy required only',
  'to receive state grant money. D = no state BWC law.',
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

/**
 * The state's BWC legal regime, established once per state and then reused.
 *
 * It is a property of the state, not the agency, so deriving it inside all
 * 1,326 Texas lookups would be 1,325 wasted classifications - and worse, they
 * could disagree with each other. The first agency in a state settles it and
 * every later one is told the answer.
 */
const stateRegimes = new Map()

/** One call: the model searches, reads, and answers with a citation. */
const researchAgency = async (agency) => {
  const regime = stateRegimes.get(agency.state) || ''
  const payload = await callOpenAI({
    model: MODEL,
    reasoning: { effort: REASONING_EFFORT },
    tools: [{ type: 'web_search', external_web_access: true }],
    // Annotations only list what the model chose to footnote. The consulted
    // source list is everything it actually opened, which is what a citation
    // check needs: matching against annotations alone rejected three real
    // sources out of three, including a wilcotx.gov budget document.
    include: ['web_search_call.action.sources'],
    // 'required', not 'auto': auto lets the model answer from memory, which is
    // exactly the unsourced verdict this must never produce.
    tool_choice: 'required',
    max_tool_calls: MAX_TOOL_CALLS,
    input: [
      { role: 'system', content: RESEARCH_RULES },
      {
        role: 'user',
        content: `${agencyBrief(agency, regime)}\n\nDo they operate body-worn cameras?`,
      },
    ],
  })
  const verdict = parseJson(getText(payload))
  // Remember the regime for the rest of this state's queue.
  if (verdict?.stateRegime && verdict.stateRegime !== 'unclear' && !regime) {
    stateRegimes.set(agency.state, verdict.stateRegime)
  }
  return {
    verdict,
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
      // Never re-pay for an agency already attempted, or one a concurrent run
      // is working on right now.
      { $or: [{ 'enrichment.bwcResearchedAt': null }, { 'enrichment.bwcResearchedAt': { $exists: false } }] },
      { 'enrichment.bwcResearchStatus': { $ne: 'processing' } },
    ],
  }
  if (args.state) selector.state = String(args.state).toUpperCase()
  if (args.ori) selector.ori = String(args.ori).toUpperCase()

  const pending = await LeAgency.find(selector)
    .select(
      'ori agencyName state stateName county agencyType contacts.website ' +
        'employment.swornOfficers surveillance.bwc',
    )
    .sort({ 'employment.swornOfficers': -1 })
    .limit(Number.isFinite(limit) ? limit : 0)
    .lean()

  console.log(`Camera research queue: ${pending.length} agencies`)
  console.log(`  one OpenAI web_search call each, up to ${MAX_TOOL_CALLS} searches per agency`)
  if (dryRun) console.log('  (dry run - searches still run, nothing is written)\n')

  const stats = {
    yes: 0,
    no: 0,
    planned: 0,
    purchased_not_deployed: 0,
    unknown: 0,
    failed: 0,
    retryable: 0,
    rejected: 0,
    claimed: 0,
  }
  let done = 0
  let cursor = 0

  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= pending.length) return
      const agency = pending[index]

      // Claim it atomically first. Stamping only on completion - which is what
      // this did - lets two workers, or a cron run that overlaps the previous
      // one, research and pay for the same agency twice.
      if (!dryRun) {
        const claimed = await LeAgency.findOneAndUpdate(
          {
            ori: agency.ori,
            'enrichment.bwcResearchStatus': { $nin: ['processing', 'ok', 'not-found'] },
          },
          {
            $set: {
              'enrichment.bwcResearchStatus': 'processing',
              'enrichment.bwcResearchStartedAt': new Date(),
            },
          },
          { new: true },
        ).lean()
        if (!claimed) {
          stats.claimed += 1
          continue
        }
      }

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
        if (!dryRun) {
          // A transient failure releases the claim so the next run retries it.
          // Leaving it on 'processing' would strand the agency forever.
          await LeAgency.updateOne(
            { ori: agency.ori },
            transient
              ? { $set: { 'enrichment.bwcResearchStatus': '' } }
              : {
                  $set: {
                    'enrichment.bwcResearchStatus': 'failed',
                    'enrichment.bwcResearchedAt': new Date(),
                  },
                },
          )
        }
        continue
      }

      const KNOWN = ['yes', 'no', 'planned', 'purchased_not_deployed']
      let status = KNOWN.includes(verdict?.status) ? verdict.status : 'unknown'
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
        `  ${mark} ${agency.agencyName.slice(0, 30).padEnd(32)}` +
          `${status.padEnd(23)}${String(verdict?.confidence || '').padEnd(7)}` +
          `${String(verdict?.contractEnd || '').padEnd(11)}s=${String(searches).padEnd(3)}` +
          `${String(verdict?.vendor || '').slice(0, 12).padEnd(14)}${sourceUrl.slice(0, 38)}`,
      )

      if (!dryRun) {
        const set = {
          'enrichment.bwcResearchStatus': status === 'unknown' ? 'not-found' : 'ok',
          'enrichment.bwcResearchedAt': new Date(),
          // Recorded even on an unknown: a thin search and an exhaustive one
          // both return nothing, and only this tells them apart.
          'surveillance.bwc.searchesRun': searches,
          'surveillance.bwc.nextAction': String(verdict?.nextAction || '').slice(0, 300),
        }
        if (status !== 'unknown') {
          set['surveillance.bwc.status'] = status
          // The map's boolean mirror. 'purchased_not_deployed' counts as having
          // them - the hardware is bought - while 'planned' does not, since
          // nothing has been acquired yet.
          set['surveillance.bwc.hasBwc'] =
            status === 'yes' || status === 'purchased_not_deployed'
          set['surveillance.bwc.evidence'] = 'researched'
          set['surveillance.bwc.asOf'] = new Date()
          set['surveillance.bwc.vendor'] = String(verdict?.vendor || '').trim()
          set['surveillance.bwc.confidence'] = ['high', 'medium', 'low'].includes(
            verdict?.confidence,
          )
            ? verdict.confidence
            : 'low'
          // A contract term expiring soon is the most actionable thing research
          // can return, so it is parsed strictly rather than stored as prose.
          const end = Date.parse(String(verdict?.contractEnd || ''))
          if (Number.isFinite(end)) set['surveillance.bwc.contractEnd'] = new Date(end)
          if (Number.isFinite(Number(verdict?.cameraCount))) {
            set['surveillance.bwc.cameraCount'] = Number(verdict.cameraCount)
          }
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
  console.log(`  purchased        ${stats.purchased_not_deployed}`)
  console.log(`  planned          ${stats.planned}`)
  console.log(`  confirmed none   ${stats.no}`)
  console.log(`  still unknown    ${stats.unknown}`)
  console.log(`  already claimed  ${stats.claimed} (another run had them)`)
  console.log(`  citation rejected ${stats.rejected} (URL was not in the search results)`)
  console.log(`  failed           ${stats.failed} (${stats.retryable} transient, will retry)`)

  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
