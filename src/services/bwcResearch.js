/**
 * Establishes whether one agency runs body-worn cameras.
 *
 * Extracted from scripts/researchBwcStatus.js so the batch run and the
 * traveller chat share exactly one prompt and one set of guards. They were
 * about to drift into two, which is how a "no" ends up meaning different
 * things depending on which route produced it.
 *
 * One OpenAI Responses call with the built-in web_search tool, forced on so a
 * verdict can never come from memory. gpt-5 rather than gpt-4.1 because 4.1
 * treats web_search as a single lookup - one call, one query, one source -
 * which makes the search discipline below unenforceable.
 */
import LeAgency from '../models/LeAgency.js'

const OPENAI_URL = 'https://api.openai.com/v1/responses'
const MODEL = process.env.BWC_RESEARCH_MODEL || 'gpt-5'
const REASONING_EFFORT = process.env.BWC_RESEARCH_EFFORT || 'low'
const MAX_TOOL_CALLS = Number(process.env.BWC_RESEARCH_MAX_TOOL_CALLS || 12)
const REQUEST_TIMEOUT_MS = Number(process.env.BWC_RESEARCH_TIMEOUT_MS || 300000)

/**
 * Streams a Responses call, reporting each web search as it starts.
 *
 * The queries are real - taken from `response.output_item.added` events for
 * web_search_call items - not a scripted animation on a timer. A fake progress
 * list would be lying about what it is doing, and the actual queries are more
 * interesting anyway: they name the council portals and check registers it is
 * digging through.
 */
const callOpenAIStreaming = async (body, onQuery) => {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, stream: true }),
    })
    if (!response.ok) {
      throw Object.assign(new Error((await response.text()).slice(0, 180)), {
        statusCode: response.status,
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const seen = new Set()
    let buffer = ''
    let final = null

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() || ''
      for (const chunk of chunks) {
        const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '))
        if (!dataLine) continue
        let event
        try {
          event = JSON.parse(dataLine.slice(6))
        } catch {
          continue
        }
        const query = event?.item?.action?.query
        // Deduped: the same call appears on both `added` and `done`.
        if (query && !seen.has(query)) {
          seen.add(query)
          onQuery?.(String(query))
        }
        if (event?.type === 'response.completed' && event.response) final = event.response
      }
    }
    if (!final) throw new Error('the search ended without a result')
    return final
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('web search timed out'), { statusCode: 504 })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

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
  '3. PAPERWORK THAT ONLY EXISTS IF THEY HAVE CAMERAS. Indirect, easy to miss,',
  '   and it has settled agencies nothing else could:',
  '   - Records retention schedules. An agency listing a retention period for',
  '     body-worn camera recordings has body-worn cameras. Texas DPS was',
  '     established exactly this way: "retained for a minimum of 90 days".',
  '   - Attorney General or state open-records rulings. An agency arguing over',
  '     whether it must release body-camera footage plainly has body cameras.',
  '     Kennedale PD was settled by a Texas AG ruling and nothing else.',
  '   - Statutory annual reports. In Texas every agency must file a TCOLE racial',
  '     profiling report yearly and those often mention cameras.',
  '     Search: "<agency>" racial profiling report body worn camera.',
  '     BEWARE: these reports frequently quote the statute itself. "The agency',
  '     shall examine the FEASIBILITY of equipping each peace officer with a body',
  '     worn camera, as that term is defined by Section 1701.651" is the law being',
  '     recited, NOT evidence this agency has any. Only count wording about what',
  '     THIS agency actually does - a named policy ("Policy 7.35 Body Worn',
  '     Cameras"), or a rule they operate under ("activation is required").',
  '   - Job adverts. "all deputies are issued body-worn cameras" turns up in',
  '     hiring posts more often than anywhere else for small agencies.',
  '     Search: "<agency>" deputy OR officer hiring body worn camera issued.',
  '4. Released footage. "<agency>" "body camera footage" released is strong proof',
  '   a programme is running.',
  '5. Local news and vendor press releases (Axon, Motorola/WatchGuard, Getac,',
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
  'confidence: high only for a primary document within the last 24 months - a',
  'contract, purchase order, policy or budget line.',
  'medium for older but uncontradicted evidence. low for anything thinner.',
  '',
  'DO NOT SEARCH FACEBOOK. Its page text, posts and captions are all behind a',
  'login and return nothing to you, so the searches are simply wasted. Anything',
  'you have seen attributed to a Facebook post was written down by a human who',
  'was logged in - it is not a source you can reach.',
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
const researchAgency = async (agency, onQuery) => {
  const regime = stateRegimes.get(agency.state) || ''
  const request = {
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
  }
  const payload = onQuery
    ? await callOpenAIStreaming(request, onQuery)
    : await callOpenAI(request)
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

/** --from takes a lat,lon or an ORI to set out from. */
const resolveOrigin = async (from) => {
  const pair = from.split(',').map(Number)
  if (pair.length === 2 && pair.every(Number.isFinite)) return { lat: pair[0], lon: pair[1] }
  const agency = await LeAgency.findOne({ ori: from.toUpperCase() })
    .select('latitude longitude location.latitude location.longitude agencyName')
    .lean()
  const coords = agency && coordsOf(agency)
  if (!coords) throw new Error(`--from=${from} is neither a lat,lon nor an ORI we can place.`)
  return coords
}

/**
 * Runs the research and writes the verdict, applying the same two guards the
 * batch run uses: a verdict reached without searching is memory rather than
 * research, and a citation the model never opened is a fabrication.
 */
export async function researchAndSaveBwc(ori, onQuery) {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() })
    .select(
      'ori agencyName state stateName county agencyType contacts.website ' +
        'employment.swornOfficers surveillance.bwc',
    )
    .lean()
  if (!agency) throw Object.assign(new Error(`No agency with ORI ${ori}`), { statusCode: 404 })

  const { verdict, citedUrls, searches } = await researchAgency(agency, onQuery)
  const KNOWN = ['yes', 'no', 'planned', 'purchased_not_deployed']
  let status = KNOWN.includes(verdict?.status) ? verdict.status : 'unknown'
  const sourceUrl = String(verdict?.sourceUrl || '').trim()
  const citedKeys = new Set([...citedUrls].map(urlKey).filter(Boolean))
  const sourceKey = urlKey(sourceUrl)
  let rejected = false
  if (status !== 'unknown') {
    if (searches === 0 || !sourceKey || (citedKeys.size > 0 && !citedKeys.has(sourceKey))) {
      rejected = true
      status = 'unknown'
    }
  }

  const set = {
    'enrichment.bwcResearchStatus': status === 'unknown' ? 'not-found' : 'ok',
    'enrichment.bwcResearchedAt': new Date(),
    'surveillance.bwc.searchesRun': searches,
    'surveillance.bwc.nextAction': String(verdict?.nextAction || '').slice(0, 300),
  }
  // Our own binary verdict, written only when we actually looked. 'planned'
  // deliberately sets nothing: budgeted is neither having them nor not.
  // A person's manual verdict is never overwritten by a later automated run:
  // they had a reason, and research that returns "unknown" is not a reason to
  // discard it.
  const setByHand = agency.surveillance?.bwc?.trustedResearchedBy === 'manual'
  if (!setByHand && (status === 'yes' || status === 'purchased_not_deployed')) {
    set['surveillance.bwc.trustedResearched'] = 'has_bwc'
    set['surveillance.bwc.trustedResearchedAt'] = new Date()
    set['surveillance.bwc.trustedResearchedBy'] = 'research'
  } else if (!setByHand && status === 'no') {
    set['surveillance.bwc.trustedResearched'] = 'no_bwc'
    set['surveillance.bwc.trustedResearchedAt'] = new Date()
    set['surveillance.bwc.trustedResearchedBy'] = 'research'
  }

  if (status !== 'unknown') {
    set['surveillance.bwc.status'] = status
    set['surveillance.bwc.hasBwc'] = status === 'yes' || status === 'purchased_not_deployed'
    set['surveillance.bwc.evidence'] = 'researched'
    set['surveillance.bwc.asOf'] = new Date()
    set['surveillance.bwc.vendor'] = String(verdict?.vendor || '').trim()
    set['surveillance.bwc.evidenceUrl'] = sourceUrl
    set['surveillance.bwc.summary'] = String(verdict?.quote || '').slice(0, 600)
    set['surveillance.bwc.source'] = 'openai_websearch_research'
    set['surveillance.bwc.importedAt'] = new Date()
    set['surveillance.bwc.confidence'] = ['high', 'medium', 'low'].includes(verdict?.confidence)
      ? verdict.confidence
      : 'low'
    const end = Date.parse(String(verdict?.contractEnd || ''))
    if (Number.isFinite(end)) set['surveillance.bwc.contractEnd'] = new Date(end)
  }
  await LeAgency.updateOne({ ori: agency.ori }, { $set: set })

  return {
    ori: agency.ori,
    name: agency.agencyName,
    status,
    rejected,
    searches,
    vendor: String(verdict?.vendor || '').trim(),
    confidence: String(verdict?.confidence || ''),
    contractEnd: String(verdict?.contractEnd || ''),
    sourceUrl,
    quote: String(verdict?.quote || '').slice(0, 400),
    nextAction: String(verdict?.nextAction || '').slice(0, 300),
  }
}

export { researchAgency, urlKey }
