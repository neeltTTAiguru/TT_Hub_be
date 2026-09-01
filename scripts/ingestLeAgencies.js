/**
 * Builds the law enforcement agency map from the FBI Crime Data Explorer.
 *
 * Two phases, both resumable:
 *   agencies    one request per state, gives ORI + name + type + lat/lon
 *   employment  one request per ORI, gives sworn officer counts by year
 *
 * The employment phase is ~19k requests. A registered api.data.gov key is
 * rate limited per hour, so the script upserts as it goes and skips agencies
 * it already has fresh data for. Re-run it until it reports nothing pending.
 *
 * Usage:
 *   node scripts/ingestLeAgencies.js --phase=agencies
 *   node scripts/ingestLeAgencies.js --phase=employment --states=IL,TX
 *   node scripts/ingestLeAgencies.js --phase=all --limit=50
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'
import { parseEmployment } from '../src/services/leAgencyEmployment.js'

dotenv.config()

const API_BASE = 'https://api.usa.gov/crime/fbi/cde'
const SOURCE_NAME = 'fbi_cde'

const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
  'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]
const TERRITORIES = ['PR', 'GU', 'VI', 'AS', 'MP']

const parseArgs = () => {
  const args = {}
  for (const raw of process.argv.slice(2)) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(raw)
    if (match) args[match[1]] = match[2] === undefined ? 'true' : match[2]
  }
  return args
}

const args = parseArgs()
const apiKey = process.env.FBI_CDE_API_KEY || 'DEMO_KEY'
const phase = args.phase || 'all'
const concurrency = Number(args.concurrency || 3)
const limit = args.limit ? Number(args.limit) : Infinity
const dryRun = args['dry-run'] === 'true'
const refresh = args.refresh === 'true'
const toYear = Number(args['to-year'] || new Date().getFullYear())
const fromYear = Number(args['from-year'] || toYear - 5)

const selectedStates = args.states
  ? args.states.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  : args['include-territories'] === 'true'
    ? [...STATES, ...TERRITORIES]
    : STATES

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const minIntervalMs = Number(args['min-interval-ms'] || 120)

// The api.data.gov edge proxy bans the whole IP on bursts, so every request
// (across all workers) is spaced by at least minIntervalMs.
let nextSlot = 0
const throttle = async () => {
  const now = Date.now()
  const slot = Math.max(now, nextSlot)
  nextSlot = slot + minIntervalMs
  if (slot > now) await sleep(slot - now)
}

/** Keeps the API key out of logs, which otherwise echo the full request URL. */
const redact = (text) => String(text).replace(/API_KEY=[^&\s]+/g, 'API_KEY=***')

const stats = {
  agenciesSeen: 0,
  agenciesUpserted: 0,
  employmentFetched: 0,
  employmentMissing: 0,
  errors: 0,
  rateLimited: false,
}

/**
 * The api.data.gov gateway returns 429 once the hourly quota is gone. Treat
 * that as a stop signal rather than a retryable error so a resumed run picks
 * up exactly where this one left off.
 */
class RateLimitReached extends Error {}

const requestJson = async (url, { attempt = 0 } = {}) => {
  await throttle()

  let response
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (error) {
    if (attempt < 3) {
      await sleep(1000 * 2 ** attempt)
      return requestJson(url, { attempt: attempt + 1 })
    }
    throw new Error(redact(error.message))
  }

  // 429 is the documented quota response; the edge proxy also returns 403
  // (OVER_RATE_LIMIT) and 503 (client_failure_limit_exceeded) when it decides
  // the IP is sending too fast. Retrying any of these deepens the ban, so stop.
  if (response.status === 429 || response.status === 503) {
    throw new RateLimitReached(`gateway throttled the request (${response.status})`)
  }

  if (response.status === 403) {
    const body = await response.text()
    if (/OVER_RATE_LIMIT|failure_limit|too many requests/i.test(body)) {
      throw new RateLimitReached('gateway throttled the request (403)')
    }
    throw new Error(`403 Forbidden for ${redact(url)}`)
  }

  if (response.status === 404) return null

  if (!response.ok) {
    if (attempt < 3) {
      await sleep(1000 * 2 ** attempt)
      return requestJson(url, { attempt: attempt + 1 })
    }
    throw new Error(`${response.status} ${response.statusText} for ${redact(url)}`)
  }

  const text = await response.text()
  if (!text.trim()) return null

  try {
    return JSON.parse(text)
  } catch {
    // The gateway serves an HTML error page for some bad paths.
    return null
  }
}

/** Runs tasks with a fixed worker pool, stopping early if the quota runs out. */
const runPool = async (items, worker) => {
  let cursor = 0
  let stopped = false

  const runWorker = async () => {
    while (!stopped) {
      const index = cursor++
      if (index >= items.length) return
      try {
        await worker(items[index], index)
      } catch (error) {
        if (error instanceof RateLimitReached) {
          stopped = true
          stats.rateLimited = true
          return
        }
        stats.errors += 1
        console.warn(`  ! ${redact(error.message)}`)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  )
}

// --- phase: agencies -------------------------------------------------------

const ingestStateAgencies = async (state) => {
  const url = `${API_BASE}/agency/byStateAbbr/${state}?API_KEY=${apiKey}`
  const payload = await requestJson(url)

  if (!payload || typeof payload !== 'object') {
    console.warn(`  ! ${state}: no agency payload`)
    return
  }

  // Response is keyed by county name, each holding an array of agencies.
  const agencies = Object.values(payload).flat().filter((a) => a?.ori)
  stats.agenciesSeen += agencies.length

  if (dryRun) {
    console.log(`  ${state}: ${agencies.length} agencies (dry run)`)
    return
  }

  // The feed uses -9 as a missing-data sentinel rather than omitting the
  // field, which plots the agency in the Atlantic if taken at face value.
  const coordinate = (value, min, max) =>
    Number.isFinite(value) && value !== -9 && value >= min && value <= max ? value : null

  const operations = agencies.map((agency) => {
    const latitude = coordinate(agency.latitude, -90, 90)
    const longitude = coordinate(agency.longitude, -180, 180)

    const set = {
      agencyName: agency.agency_name || '',
      agencyType: agency.agency_type_name || '',
      state: agency.state_abbr || state,
      stateName: agency.state_name || '',
      county: agency.counties || '',
      isNibrs: Boolean(agency.is_nibrs),
      nibrsStartDate: agency.nibrs_start_date || '',
      latitude,
      longitude,
    }

    if (latitude !== null && longitude !== null) {
      set.geo = { type: 'Point', coordinates: [longitude, latitude] }
    }

    return {
      updateOne: {
        filter: { ori: String(agency.ori).toUpperCase() },
        update: {
          $set: set,
          $setOnInsert: { ori: String(agency.ori).toUpperCase() },
          $addToSet: { nameVariants: agency.agency_name || '' },
        },
        upsert: true,
      },
    }
  })

  if (operations.length) {
    const result = await LeAgency.bulkWrite(operations, { ordered: false })
    stats.agenciesUpserted += (result.upsertedCount || 0) + (result.modifiedCount || 0)
  }

  console.log(`  ${state}: ${agencies.length} agencies`)
}

const runAgenciesPhase = async () => {
  console.log(`\nPhase 1 - agency roster (${selectedStates.length} states)`)
  for (const state of selectedStates) {
    try {
      await ingestStateAgencies(state)
    } catch (error) {
      if (error instanceof RateLimitReached) {
        stats.rateLimited = true
        console.warn('  ! hourly quota exhausted, stopping')
        return
      }
      stats.errors += 1
      console.warn(`  ! ${state}: ${redact(error.message)}`)
    }
  }
}

// --- phase: employment -----------------------------------------------------

const ingestAgencyEmployment = async (agency) => {
  const url = `${API_BASE}/pe/agency/${encodeURIComponent(agency.ori)}?from=${fromYear}&to=${toYear}&API_KEY=${apiKey}`
  const payload = await requestJson(url)
  const history = parseEmployment(payload)

  if (!history.length) {
    stats.employmentMissing += 1
    if (!dryRun) {
      // Stamp the attempt so a resumed run does not retry it forever.
      await LeAgency.updateOne(
        { ori: agency.ori },
        { $set: { 'employment.fetchedAt': new Date(), 'employment.source': SOURCE_NAME } },
      )
    }
    return
  }

  const latest = history[history.length - 1]
  stats.employmentFetched += 1

  if (dryRun) {
    console.log(`  ${agency.ori} ${agency.agencyName}: ${latest.swornOfficers} sworn (${latest.year})`)
    return
  }

  await LeAgency.updateOne(
    { ori: agency.ori },
    {
      $set: {
        employment: {
          swornOfficers: latest.swornOfficers,
          maleOfficers: latest.maleOfficers,
          femaleOfficers: latest.femaleOfficers,
          civilians: latest.civilians,
          totalEmployees: latest.totalEmployees,
          employeesPer1000: latest.employeesPer1000,
          dataYear: latest.year,
          source: SOURCE_NAME,
          fetchedAt: new Date(),
        },
        employmentHistory: history,
      },
      $addToSet: {
        provenance: {
          source: SOURCE_NAME,
          url: `${API_BASE}/pe/agency/${agency.ori}`,
          retrievedAt: new Date(),
        },
      },
    },
  )
}

const runEmploymentPhase = async () => {
  const query = {}
  if (args.states) query.state = { $in: selectedStates }
  if (!refresh) query['employment.fetchedAt'] = null

  const pending = await LeAgency.find(query)
    .select('ori agencyName state')
    .sort({ state: 1, ori: 1 })
    .limit(Number.isFinite(limit) ? limit : 0)
    .lean()

  console.log(`\nPhase 2 - employment counts (${pending.length} agencies pending)`)
  if (!pending.length) return

  let done = 0
  await runPool(pending, async (agency) => {
    await ingestAgencyEmployment(agency)
    done += 1
    if (done % 250 === 0) console.log(`  ...${done}/${pending.length}`)
  })
}

// --- main ------------------------------------------------------------------

const main = async () => {
  const mongoUri = process.env.MONGODB_URI
  if (!mongoUri) throw new Error('MONGODB_URI is not set')
  if (apiKey === 'DEMO_KEY') {
    console.warn('! Using DEMO_KEY (10 requests/hour). Set FBI_CDE_API_KEY for real runs.')
  }

  await mongoose.connect(mongoUri)
  console.log('Connected to MongoDB')

  if (phase === 'agencies' || phase === 'all') await runAgenciesPhase()
  if ((phase === 'employment' || phase === 'all') && !stats.rateLimited) {
    await runEmploymentPhase()
  }

  const total = await LeAgency.countDocuments()
  const withCounts = await LeAgency.countDocuments({ 'employment.swornOfficers': { $ne: null } })
  const small = await LeAgency.countDocuments({
    'employment.swornOfficers': { $ne: null, $lte: 100 },
  })
  const remaining = await LeAgency.countDocuments({ 'employment.fetchedAt': null })

  console.log('\nSummary')
  console.log(`  agencies in db      ${total}`)
  console.log(`  with officer counts ${withCounts}`)
  console.log(`  <= 100 sworn        ${small}`)
  console.log(`  employment pending  ${remaining}`)
  console.log(`  no data reported    ${stats.employmentMissing} (this run)`)
  console.log(`  errors              ${stats.errors}`)
  if (stats.rateLimited) {
    console.log('\n! Stopped early: the api.data.gov gateway is throttling this IP. Re-run to resume.')
  }

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
