/**
 * Drives a research run in the background.
 *
 * The loop lives in the server process, not in the browser. That is what lets
 * you close the tab, log out, go home, and still have the traveller walking
 * when you open the hub in the morning - and what lets two people watch the
 * same run at the same time.
 *
 * One agency at a time, deliberately. The traveller walking a route is the
 * whole idea, and three concurrent workers would produce three positions and no
 * path. It also keeps a mistake cheap: a run doing something wrong is caught
 * one agency in, not thirty.
 */
import crypto from 'node:crypto'
import LeAgency from '../models/LeAgency.js'
import BwcResearchRun from '../models/BwcResearchRun.js'
import TravellerState from '../models/TravellerState.js'
import { researchAndSaveBwc } from './bwcResearch.js'
import { researchLeadership, saveLeadership } from './agencyLeadership.js'
import { recordAgencyResearch } from './agencyResearchLog.js'

const LEASE_MS = 5 * 60 * 1000
// A pause between agencies. Not rate limiting - it is so a run cannot spend
// money faster than a person watching it can hit stop.
const GAP_MS = Number(process.env.BWC_RUN_GAP_MS || 1500)

/**
 * Stop the run rather than burn through the queue failing.
 *
 * Without this, an expired OpenAI balance turns into 889 instant failures in
 * about a minute: every agency errors, every agency is marked done-with-nothing,
 * and the run reports "finished" having researched none of them. The failure
 * has to halt the run, not be counted by it.
 *
 * Nothing is lost by halting. A failed agency never gets its researched-at
 * stamp, so it still matches the filter - top the account up, start the run
 * again, and it picks up exactly where this one stopped.
 */
const MAX_CONSECUTIVE_FAILURES = 5

/** Errors that will not fix themselves by trying the next agency. */
const isFatal = (error = '', statusCode = 0) =>
  statusCode === 401 ||
  statusCode === 403 ||
  /insufficient_quota|exceeded your current quota|billing_not_active|account_deactivated|invalid_api_key|Incorrect API key|OPENAI_API_KEY is not set/i.test(
    String(error),
  )

const leaseId = crypto.randomUUID()
let looping = false

const coordsOf = (agency) => {
  const lat = agency?.location?.latitude ?? agency?.latitude
  const lon = agency?.location?.longitude ?? agency?.longitude
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
}

const milesBetween = (a, b) => {
  if (!a || !b) return Infinity
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 3963.2 * 2 * Math.asin(Math.sqrt(h))
}

/**
 * Nearest-neighbour, so the traveller walks a route instead of teleporting
 * around the state in database order. Not the shortest tour - it does not need
 * to be, it needs to look like somebody travelling.
 */
export const orderAsJourney = (agencies, origin) => {
  const placed = []
  const unplaced = []
  for (const agency of agencies) (coordsOf(agency) ? placed : unplaced).push(agency)

  const route = []
  let at = origin || coordsOf(placed[0]) || { lat: 31.9686, lon: -99.9018 }
  const pool = [...placed]
  while (pool.length) {
    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < pool.length; i += 1) {
      const distance = milesBetween(at, coordsOf(pool[i]))
      if (distance < bestDistance) {
        bestDistance = distance
        best = i
      }
    }
    const [next] = pool.splice(best, 1)
    route.push(next)
    at = coordsOf(next)
  }
  // Agencies with no coordinate go last: they cannot be routed, and putting
  // them first would strand the traveller off-map at the start of the run.
  return [...route, ...unplaced]
}

/** The one run that is currently going, if any. */
export const activeRun = () =>
  BwcResearchRun.findOne({ status: { $in: ['running', 'stopping'] } }).sort({ createdAt: -1 })

/**
 * Build the queue and start walking.
 *
 * `oris` is resolved by the caller, which owns the filter builder. The queue is
 * frozen at this moment on purpose: research changes what matches the filters,
 * so a queue re-derived each tick would shrink under its own results.
 */
export async function startRun({
  oris,
  brief = '',
  filters = {},
  filtersLabel = '',
  skipResearched = true,
  includeOffMap = false,
  limit = null,
  startedBy = '',
  assignedTo = '',
}) {
  const existing = await activeRun()
  if (existing) {
    throw Object.assign(new Error('A research run is already going.'), { statusCode: 409 })
  }

  const agencies = await LeAgency.find({ ori: { $in: oris } })
    .select('ori agencyName state latitude longitude location')
    .lean()

  // Start from wherever the traveller is standing, so a run picks up from his
  // last stop rather than restarting the journey somewhere arbitrary.
  const traveller = await TravellerState.findOne({ key: 'singleton' }).lean()
  const origin =
    Number.isFinite(traveller?.lat) && Number.isFinite(traveller?.lon)
      ? { lat: traveller.lat, lon: traveller.lon }
      : null

  let queue = orderAsJourney(agencies, origin).map((agency) => agency.ori)
  if (Number.isFinite(limit) && limit > 0) queue = queue.slice(0, limit)
  if (!queue.length) {
    throw Object.assign(new Error('Nothing matches this targeting.'), { statusCode: 400 })
  }

  const run = await BwcResearchRun.create({
    status: 'running',
    brief,
    filters,
    filtersLabel,
    skipResearched,
    includeOffMap,
    queue,
    total: queue.length,
    startedBy,
    assignedTo,
    leaseId,
    leaseExpiresAt: new Date(Date.now() + LEASE_MS),
  })

  void loop()
  return run
}

/**
 * Ask the run to stop.
 *
 * It stops between agencies, not mid-agency: the OpenAI call is already paid
 * for by the time it is in flight, so abandoning it would throw away the answer
 * and still be billed for it.
 */
export async function stopRun() {
  const run = await activeRun()
  if (!run) return null
  run.status = 'stopping'
  await run.save()
  return run
}

const stopFor = (agency, extra = {}) => ({
  ori: agency.ori,
  name: agency.agencyName,
  state: agency.state,
  ...(coordsOf(agency) || { lat: null, lon: null }),
  at: new Date(),
  ...extra,
})

/** Keep the shared traveller position in step with the run. */
const moveTravellerTo = (agency) =>
  TravellerState.updateOne(
    { key: 'singleton' },
    {
      $set: {
        ori: agency.ori,
        name: agency.agencyName,
        state: agency.state || '',
        county: agency.county || '',
        ...(coordsOf(agency) || {}),
        movedAt: new Date(),
      },
    },
    { upsert: true },
  )

/**
 * Research one agency: cameras, then the decision maker and phone.
 *
 * Both halves are attempted even if the first fails. A run that gives up on the
 * contact details because the camera search came back empty would leave the
 * least-documented agencies - the ones most worth a phone call - with the least
 * information.
 */
async function researchOne(agency) {
  const result = {
    verdict: 'unknown',
    searches: 0,
    foundEmail: false,
    foundPhone: false,
    error: '',
    fatal: false,
    cameras: {},
    contact: {},
    added: {},
    agencyType: agency.agencyType || '',
    county: agency.county || '',
    swornOfficers: agency.employment?.swornOfficers ?? null,
  }

  // What was already on file before the traveller arrived, so the run can
  // distinguish what it found from what it merely confirmed.
  const before = {
    email: agency.contacts?.email || '',
    phone: agency.contacts?.phone || '',
    chief: agency.contacts?.chiefName || '',
    cameras: agency.surveillance?.bwc?.trustedResearched || '',
  }

  try {
    const bwc = await researchAndSaveBwc(agency.ori)
    result.verdict = bwc.status === 'unknown' ? 'unknown' : bwc.status
    result.searches += bwc.searches || 0
    result.cameras = {
      verdict: bwc.status,
      // Kept even for an unknown: the source and confidence still say how hard
      // it was looked for, which is the difference between "no answer exists"
      // and "nobody looked".
      reasoning: bwc.quote || '',
      sourceUrl: bwc.sourceUrl || '',
      confidence: bwc.confidence || '',
      vendor: bwc.vendor || '',
      contractEnd: bwc.contractEnd || '',
    }
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 200)
    result.fatal = isFatal(result.error, error?.statusCode)
  }

  try {
    const leadership = await researchLeadership(agency, { collectEmail: true })
    await saveLeadership(agency.ori, leadership)
    result.searches += leadership?.searches || 0
  } catch (error) {
    const message = String(error?.message || error).slice(0, 200)
    if (!result.error) result.error = message
    if (isFatal(message, error?.statusCode)) result.fatal = true
  }

  // Count what the agency HAS, not what this one call happened to return.
  //
  // Scoring the API response meant an agency whose phone we already knew
  // scored zero, so the tally read "0 phone numbers" next to a row that
  // plainly had one. The counters exist to tell you what is in the
  // spreadsheet, so they have to be read back from the same place the
  // spreadsheet is.
  const saved = await LeAgency.findOne({ ori: agency.ori })
    .select('contacts surveillance.bwc.trustedResearched')
    .lean()
  const after = saved?.contacts || {}
  result.foundEmail = Boolean(after.email)
  result.foundPhone = Boolean(after.phone)
  const trusted = saved?.surveillance?.bwc?.trustedResearched || ''
  if (trusted === 'has_bwc') result.verdict = 'yes'
  if (trusted === 'no_bwc') result.verdict = 'no'

  result.contact = {
    chiefName: after.chiefName || '',
    chiefTitle: after.chiefTitle || '',
    email: after.email || '',
    phone: after.phone || '',
    website: after.website || '',
    sourceUrl: after.chiefSourceUrl || '',
  }
  result.added = {
    cameras: Boolean(trusted) && trusted !== before.cameras,
    email: Boolean(after.email) && after.email !== before.email,
    phone: Boolean(after.phone) && after.phone !== before.phone,
    chief: Boolean(after.chiefName) && after.chiefName !== before.chief,
  }

  return result
}

async function loop() {
  if (looping) return
  looping = true
  let consecutiveFailures = 0
  try {
    for (;;) {
      const run = await activeRun()
      if (!run) return

      if (run.status === 'stopping') {
        run.status = 'stopped'
        run.current = null
        run.finishedAt = new Date()
        await run.save()
        return
      }

      if (run.cursor >= run.queue.length) {
        run.status = 'done'
        run.current = null
        run.finishedAt = new Date()
        await run.save()
        return
      }

      const ori = run.queue[run.cursor]
      const agency = await LeAgency.findOne({ ori })
        .select('ori agencyName state stateName county agencyType contacts employment surveillance.bwc latitude longitude location')
        .lean()

      if (!agency) {
        run.cursor += 1
        run.failed += 1
        await run.save()
        continue
      }

      run.current = stopFor(agency)
      run.leaseId = leaseId
      run.leaseExpiresAt = new Date(Date.now() + LEASE_MS)
      await run.save()
      await moveTravellerTo(agency)

      const outcome = await researchOne(agency)
      await recordAgencyResearch(agency.ori, {
        source: 'run',
        runId: run._id,
        by: run.startedBy,
        searches: outcome.searches,
        error: outcome.error,
        added: outcome.added,
      })

      // Re-read: the run may have been asked to stop while this agency was in
      // flight, and saving the stale document would undo that request.
      const fresh = await BwcResearchRun.findById(run._id)
      if (!fresh) return
      fresh.path.push(stopFor(agency, outcome))
      fresh.cursor += 1
      fresh.searches += outcome.searches
      if (outcome.error) fresh.failed += 1
      else fresh.completed += 1
      if (outcome.verdict === 'yes' || outcome.verdict === 'purchased_not_deployed') {
        fresh.foundCameras += 1
      }
      if (outcome.foundEmail) fresh.foundEmails += 1
      if (outcome.foundPhone) fresh.foundPhones += 1
      if (outcome.error) fresh.lastError = outcome.error
      fresh.current = null
      fresh.leaseExpiresAt = new Date(Date.now() + LEASE_MS)

      consecutiveFailures = outcome.error ? consecutiveFailures + 1 : 0
      const halt =
        outcome.fatal || (outcome.error && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)
      if (halt) {
        fresh.status = 'failed'
        fresh.finishedAt = new Date()
        fresh.lastError = outcome.fatal
          ? `Stopped: ${outcome.error}. Nothing after this agency was researched or charged - fix the account and start the run again to carry on.`
          : `Stopped after ${consecutiveFailures} failures in a row. Last error: ${outcome.error}. Start the run again to carry on from here.`
        await fresh.save()
        console.error(`[research-run] halted at ${fresh.cursor}/${fresh.queue.length}: ${outcome.error}`)
        return
      }

      await fresh.save()
      await new Promise((resolve) => setTimeout(resolve, GAP_MS))
    }
  } catch (error) {
    const run = await activeRun()
    if (run) {
      run.status = 'failed'
      run.lastError = String(error?.message || error).slice(0, 300)
      run.finishedAt = new Date()
      run.current = null
      await run.save()
    }
  } finally {
    looping = false
  }
}

/**
 * Pick a run back up after a restart.
 *
 * A deploy or a crash leaves a run marked 'running' with nothing driving it.
 * Because progress is a cursor into a stored queue, resuming is just starting
 * the loop again - it carries on at the next agency, having paid for none twice.
 */
export async function resumeRunOnBoot() {
  const run = await activeRun()
  if (!run) return null
  if (run.status === 'stopping') {
    run.status = 'stopped'
    run.finishedAt = new Date()
    await run.save()
    return null
  }
  console.log(
    `[research-run] resuming ${run._id} at ${run.cursor}/${run.queue.length}`,
  )
  void loop()
  return run
}
