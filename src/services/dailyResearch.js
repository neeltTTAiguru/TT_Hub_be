/**
 * The morning schedule: research a fixed number of random agencies for each
 * SAE, then hand those agencies to them.
 *
 * Built as a tick, not a timer that fires once. Every minute the scheduler
 * asks three questions against the database: is it past the hour and has
 * today been claimed; does today's plan have an entry waiting and is the
 * traveller free; has the entry that was running finished. Each answer moves
 * the plan one step. That shape survives everything that goes wrong with a
 * 5 AM job - a restart, a deploy mid-run, the laptop being asleep at five and
 * awake at nine - because the plan is in Mongo and any process can advance it.
 *
 * Two processes share that database (local and production). The day document
 * is the lock: one insert wins the morning, and every entry flips
 * pending -> starting with an atomic update so a run is never started twice.
 *
 * The picks are random from the person's own scope, restricted to agencies
 * whose camera status is unknown and that nobody has researched. Unknown
 * only, deliberately: a "no" and a "yes" are both answers the SAE can act on,
 * and an unknown is the one thing research can turn into a lead.
 */
import os from 'node:os'
import DailyResearchDay from '../models/DailyResearchDay.js'
import DailyResearchSchedule from '../models/DailyResearchSchedule.js'
import HubMember from '../models/HubMember.js'
import BwcResearchRun from '../models/BwcResearchRun.js'
import LeAgency from '../models/LeAgency.js'
import { activeRun, startRun } from './researchRunner.js'
import { hasFullAccess } from '../middleware/featureAccess.js'
import { buildFilter, describeFilters } from './leAgencyFilters.js'
import { runFindingsRows } from './researchRunWorkbook.js'
import { sendAsMember } from './gmail.js'

const TICK_MS = 60 * 1000
// How long after the hour a missed morning is still run. Past this it waits
// for tomorrow: switching the schedule on at noon must not spend the day's
// budget at noon. "Run now" on the board is the deliberate version of that.
const GRACE_MINUTES = 180
// A person's number is leads, not agencies researched: when research rules
// some out (cameras found), the shortfall is drawn again. Bounded so a bad
// morning cannot spend without limit - at worst about this many times the
// quota gets researched.
const MAX_ROUNDS = 4

// A settle takes seconds: count a finished run, maybe start a top-up, send an
// email. One sitting in 'settling' longer than this was claimed by a process
// that then died or lost its database - 2026-09-17 it wedged Kyle at 27 of 40
// for five hours and never started Neil or Troy - so it is taken back over.
const SETTLE_STALE_MS = 10 * 60 * 1000
const PLOTTABLE = { $or: [{ geo: { $exists: true } }, { 'location.geo': { $exists: true } }] }
const NOT_RESEARCHED = {
  'enrichment.bwcResearchedAt': null,
  'surveillance.bwc.trustedResearched': { $nin: ['has_bwc', 'no_bwc'] },
}

const me = `${os.hostname()}:${process.pid}`

const DEFAULT_PICK = { states: [], agencyTypes: [], maxOfficers: 25, camera: 'unknown' }

export const getSchedule = async () => {
  const doc = await DailyResearchSchedule.findOne({ key: 'singleton' }).lean()
  return {
    key: 'singleton',
    enabled: false,
    hour: 5,
    minute: 0,
    timezone: 'America/Los_Angeles',
    ...(doc || {}),
    pick: { ...DEFAULT_PICK, ...(doc?.pick || {}) },
  }
}

export async function saveSchedule({ enabled, hour, minute, pick, notifyFrom, notifyCc, updatedBy = '' }) {
  const set = { updatedBy }
  if (typeof notifyFrom === 'string') set.notifyFrom = notifyFrom.trim().toLowerCase()
  if (Array.isArray(notifyCc)) {
    set.notifyCc = [...new Set(notifyCc.map((v) => String(v).trim().toLowerCase()).filter((v) => v.includes('@')))]
  }
  if (typeof enabled === 'boolean') set.enabled = enabled
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23) set.hour = hour
  if (Number.isInteger(minute) && minute >= 0 && minute <= 59) set.minute = minute
  if (pick && typeof pick === 'object') {
    const list = (value, upper = false) =>
      Array.isArray(value)
        ? [...new Set(value.map((v) => String(v).trim()).map((v) => (upper ? v.toUpperCase() : v)).filter(Boolean))]
        : []
    const max = Number(pick.maxOfficers)
    set.pick = {
      states: list(pick.states, true),
      agencyTypes: list(pick.agencyTypes),
      maxOfficers: Number.isFinite(max) && max > 0 ? Math.floor(max) : null,
      camera: 'unknown',
    }
  }
  return DailyResearchSchedule.findOneAndUpdate(
    { key: 'singleton' },
    { $set: set, $setOnInsert: { key: 'singleton' } },
    { upsert: true, new: true },
  ).lean()
}

/** The wall clock in the schedule's timezone: date string and minutes since midnight. */
export function localNow(timezone, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) % 24 * 60 + Number(parts.minute),
  }
}

/**
 * The picker's targeting: the schedule's pick scope (states, size, camera
 * status), and never anything already researched. Deliberately not the person's map scope - their map is what
 * they are working now (Texas, say), and the picks are new ground.
 */
const pickFilter = (schedule) => {
  const pick = schedule.pick || DEFAULT_PICK
  // Always the yellow pins. The morning exists to turn unknowns into leads;
  // researching an agency whose status is already known buys nothing.
  const query = { bwc: 'unknown' }
  if (pick.states?.length) query.state = pick.states.join(',')
  if (pick.agencyTypes?.length) query.agencyType = pick.agencyTypes.join(',')
  if (Number.isFinite(pick.maxOfficers)) query.maxOfficers = String(pick.maxOfficers)
  return {
    query,
    where: { $and: [buildFilter(query), { isTestRecord: { $ne: true } }, PLOTTABLE, NOT_RESEARCHED] },
  }
}

/**
 * Every agency any run has ever queued, for anyone.
 *
 * The pick already excludes researched agencies, but a stop that errored is
 * never stamped as researched - so without this, Troy's draw could hand him
 * an agency that was Kyle's yesterday. Queued is queued: it belongs to the
 * person it was queued for, whether or not the research came back.
 */
async function everQueued() {
  const runs = await BwcResearchRun.find({}).select('queue').lean()
  return [...new Set(runs.flatMap((run) => run.queue || []))]
}

/** How many agencies are left to draw from. */
export async function poolSize(schedule) {
  const { where } = pickFilter(schedule || (await getSchedule()))
  return LeAgency.countDocuments({ $and: [where, { ori: { $nin: await everQueued() } }] })
}

/**
 * Build today's plan from the board and claim the day. Returns the day
 * document if this process won it, null if someone else already had.
 */
async function claimDay(date, trigger) {
  const members = await HubMember.find({ dailyResearch: { $gt: 0 } }).sort({ dailyResearch: -1, email: 1 }).lean()
  const plan = members
    .filter((member) => !hasFullAccess(member.email))
    .map((member) => ({ email: member.email, count: Math.min(Math.floor(member.dailyResearch), 500) }))
  try {
    const day = await DailyResearchDay.create({ date, claimedBy: me, trigger, plan })
    console.log(`[daily-research] ${date} claimed by ${me}: ${plan.map((p) => `${p.email}=${p.count}`).join(', ') || 'nobody to research for'}`)
    return day
  } catch (error) {
    if (error?.code === 11000) return null
    throw error
  }
}

/**
 * Start one entry, or top it up: pick, run, assign. Returns the run, or null
 * when nothing was started (the entry is then already marked).
 */
async function startEntry(day, entry) {
  const member = await HubMember.findOne({ email: entry.email }).lean()
  const mark = (set) =>
    DailyResearchDay.updateOne({ _id: day._id, 'plan.email': entry.email }, { $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`plan.$.${k}`, v])) })

  if (!member) {
    await mark({ status: 'skipped', note: 'No longer on the board.', finishedAt: new Date() })
    return null
  }

  const { query, where } = pickFilter(await getSchedule())
  // How many more leads they still need, not the whole number again.
  const need = Math.max(entry.count - (entry.leads || 0), 0)
  if (!need) {
    await mark({ status: 'done', finishedAt: new Date() })
    return null
  }
  // Re-read at the moment of the draw, not at the start of the morning, so
  // the entry before this one - just finished - is already excluded.
  const taken = await everQueued()
  const picked = await LeAgency.aggregate([
    { $match: { $and: [where, { ori: { $nin: taken } }] } },
    { $sample: { size: need } },
    { $project: { ori: 1 } },
  ])
  const oris = picked.map((row) => row.ori)
  if (!oris.length) {
    await mark({
      status: entry.leads ? 'done' : 'skipped',
      note: 'Nothing left to pick: every agency in the pick scope is researched or has a known camera status.',
      finishedAt: new Date(),
    })
    return null
  }

  const label = describeFilters(query)
  const round = (entry.rounds || 0) + 1
  const run = await startRun({
    oris,
    brief: `Daily research for ${member.name || member.email}: ${oris.length} random agencies, ${label}${round > 1 ? ` (top-up ${round})` : ''}.`,
    filters: query,
    filtersLabel: `${member.name || member.email} - ${label}`,
    skipResearched: true,
    includeOffMap: false,
    startedBy: 'daily-research',
    assignedTo: member.email,
  })

  // Hand it over: the run joins their assignments, which their map always
  // shows on top of their scope. Accumulates - yesterday's uncalled agencies
  // stay on the map.
  await HubMember.updateOne({ email: member.email }, { $addToSet: { assignedRunIds: String(run._id) } })

  await DailyResearchDay.updateOne(
    { _id: day._id, 'plan.email': entry.email },
    {
      $set: {
        'plan.$.status': 'running',
        'plan.$.runId': String(run._id),
        'plan.$.rounds': round,
        ...(entry.startedAt ? {} : { 'plan.$.startedAt': new Date() }),
      },
      $push: { 'plan.$.runIds': String(run._id) },
      $inc: { 'plan.$.queued': oris.length },
    },
  )
  return run
}

/**
 * Leads a run delivered: researched and not yet running cameras - nothing
 * published either way, or a purchase only planned, so a call can settle or
 * win it. A yes is ruled out; a no is an answer, not a lead to chase, and is
 * on their map without counting here.
 */
export const isLead = (row) => row.cameras === 'Unknown' || row.cameras === 'Planned'
const leadsIn = (run) => runFindingsRows(run).filter(isLead).length

/** Leads over every run an entry has started, from the runs themselves. */
async function leadsAcross(runIds) {
  const runs = await BwcResearchRun.find({ _id: { $in: runIds.filter(Boolean) } }).lean()
  return runs.reduce((sum, run) => sum + leadsIn(run), 0)
}

/**
 * Move today's plan one step, if there is a step to take. Safe to call from
 * any process at any time.
 */
export async function advance({ force = false } = {}) {
  const schedule = await getSchedule()
  const { date, minutes } = localNow(schedule.timezone)
  const target = schedule.hour * 60 + schedule.minute
  const due = minutes >= target && minutes < target + GRACE_MINUTES

  let day = await DailyResearchDay.findOne({ date })
  if (!day) {
    if (force) day = await claimDay(date, 'manual')
    else if (schedule.enabled && due) day = await claimDay(date, 'scheduled')
    if (!day) return null
  }
  if (day.finishedAt) return day

  // Settle whatever was running - or whatever a dead process left half-settled.
  const staleBefore = new Date(Date.now() - SETTLE_STALE_MS)
  const abandoned = (entry) =>
    entry.status === 'settling' && (!entry.settlingAt || new Date(entry.settlingAt) < staleBefore)
  const running = day.plan.find((entry) => entry.status === 'running' || abandoned(entry))
  if (running) {
    const run = await BwcResearchRun.findById(running.runId).lean()
    if (!run || ['done', 'stopped', 'failed'].includes(run.status)) {
      // Claim the settle atomically ('settling'), so two backends ticking
      // against the same plan count, top up and email exactly once. A stale
      // settle is claimed the same way, by its old timestamp, so two backends
      // cannot both take it back over.
      const claimed = await DailyResearchDay.updateOne(
        {
          _id: day._id,
          'plan.email': running.email,
          'plan.runId': running.runId,
          ...(running.status === 'settling'
            ? { 'plan.status': 'settling', 'plan.settlingAt': running.settlingAt || null }
            : { 'plan.status': 'running' }),
        },
        { $set: { 'plan.$.status': 'settling', 'plan.$.settlingAt': new Date() } },
      )
      if (!claimed.modifiedCount) return day

      // Counted from every run this entry has had, not accumulated - so a
      // settle that is taken over and redone cannot count the same run twice.
      const leads = await leadsAcross(running.runIds?.length ? running.runIds : [running.runId])
      await DailyResearchDay.updateOne({ _id: day._id, 'plan.email': running.email }, { $set: { 'plan.$.leads': leads } })
      // toObject first: `running` is a Mongoose subdocument, and spreading one
      // copies its internals but none of its fields - email, count and rounds
      // all came out undefined, so the top-up drew for nobody and marked
      // nothing done, and the entry sat in 'settling' for good.
      const entry = { ...(running.toObject ? running.toObject() : running), leads }

      // Short of the number, the run went fine, rounds left: draw the
      // shortfall now - the traveller is free, this run just ended.
      const short = leads < entry.count
      const canTopUp = run && run.status !== 'failed' && (entry.rounds || 1) < MAX_ROUNDS
      if (short && canTopUp) {
        try {
          const next = await startEntry(day, entry)
          if (next) return DailyResearchDay.findById(day._id)
        } catch (error) {
          console.error(`[daily-research] top-up for ${entry.email} failed: ${error?.message || error}`)
        }
      }

      await DailyResearchDay.updateOne(
        { _id: day._id, 'plan.email': entry.email },
        {
          $set: {
            'plan.$.status': run?.status === 'failed' && !leads ? 'failed' : 'done',
            'plan.$.finishedAt': new Date(),
            ...(short && !canTopUp && run?.status !== 'failed'
              ? { 'plan.$.note': `${leads} of ${entry.count} - stopped after ${entry.rounds || 1} rounds.` }
              : {}),
          },
        },
      )
      if (run) {
        await notifyLeadsReady(day, entry, schedule).catch((error) =>
          console.error(`[daily-research] could not email ${entry.email}: ${error?.message || error}`),
        )
      }
      day = await DailyResearchDay.findById(day._id)
    } else {
      return day
    }
  }

  if (day.plan.some((entry) => entry.status === 'settling' && !abandoned(entry))) return day
  const next = day.plan.find((entry) => entry.status === 'pending')
  if (!next) {
    await DailyResearchDay.updateOne({ _id: day._id }, { $set: { finishedAt: new Date() } })
    console.log(`[daily-research] ${date} finished.`)
    return DailyResearchDay.findById(day._id)
  }

  // Only one run at a time - wait for the traveller to be free, whoever is
  // using him.
  if (await activeRun()) return day

  // Claim the entry atomically; the other backend may be ticking too.
  const claimed = await DailyResearchDay.updateOne(
    { _id: day._id, 'plan.email': next.email, 'plan.status': 'pending' },
    { $set: { 'plan.$.status': 'starting' } },
  )
  if (!claimed.modifiedCount) return day

  try {
    await startEntry(day, next)
  } catch (error) {
    console.error(`[daily-research] could not start ${next.email}: ${error?.message || error}`)
    await DailyResearchDay.updateOne(
      { _id: day._id, 'plan.email': next.email },
      { $set: { 'plan.$.status': 'failed', 'plan.$.note': String(error?.message || error).slice(0, 300), 'plan.$.finishedAt': new Date() } },
    )
  }
  return DailyResearchDay.findById(day._id)
}

/** The leads email, as text. Pure, so it can be read before anyone gets it. */
export function buildLeadsEmail({ rows, to, entry, day, from }) {
  const researched = rows.filter((row) => row.cameras !== 'Not researched')
  // Found to have cameras: ruled out. Found to have none: settled. Neither is
  // a lead; the leads are the unknowns.
  const ruledOut = researched.filter((row) => row.cameras === 'Yes').length
  const settledNo = researched.filter((row) => row.cameras === 'No').length
  const found = researched.filter(isLead)
  const withEmail = found.filter((row) => row.email).length
  const withPhone = found.filter((row) => row.phone).length
  const firstName = (to?.name || entry.email.split('@')[0]).split(/\s+/)[0]
  // The people reading this use the hosted hub, whichever backend happened to
  // run their research - a localhost link from the laptop backend is useless
  // to Kyle. So the fallback is production, never a dev server.
  const hub = (process.env.HUB_FRONTEND_URL?.trim() || 'https://trusted-fe-hub-agl8a.ondigitalocean.app').replace(/\/$/, '')

  // Counties arrive upper-cased from the FBI feed; the email is read by a person.
  const titleCase = (text) => String(text).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
  const line = (row) => {
    const where = [row.county ? `${titleCase(row.county)} County` : '', row.state].filter(Boolean).join(', ')
    const who = row.chief ? `${row.chief}${row.chiefTitle ? `, ${row.chiefTitle}` : ''}` : 'decision maker not found'
    const reach = [row.phone, row.email].filter(Boolean).join(' · ') || 'no contact found'
    return `- ${row.agency}${where ? ` (${where})` : ''}\n    ${who}\n    ${reach}`
  }

  const text = [
    `Hi ${firstName},`,
    '',
    `The traveller researched ${researched.length} agencies for you overnight and found ${found.length} new leads - agencies with no published body camera status, so a call can settle it. They are on your map now, on top of your Texas list.`,
    '',
    `${withEmail} have an email address and ${withPhone} have a phone number.${ruledOut || settledNo ? ` Left off: ${[ruledOut ? `${ruledOut} already have cameras` : '', settledNo ? `${settledNo} confirmed none` : ''].filter(Boolean).join(', ')}.` : ''}`,
    '',
    `Open the map: ${hub}/agency-map`,
    '',
    `Your new leads (${day.date}):`,
    ...found.map(line),
    ...(rows.length > researched.length ? ['', `${rows.length - researched.length} could not be researched and will be retried another day.`] : []),
    '',
    `Sent by the Smart Hub on behalf of ${from.name || from.email}.`,
  ].join('\n')

  return { subject: `${found.length} new leads on your map - ${day.date}`, text, found: found.length }
}

/**
 * Tell the person their morning's leads are on the map, from the notifier's
 * own Gmail. Plain text, with the leads listed so the email is useful on a
 * phone before they open the hub. Recorded on the plan entry either way.
 */
async function notifyLeadsReady(day, entry, schedule) {
  const note = (text) =>
    DailyResearchDay.updateOne({ _id: day._id, 'plan.email': entry.email }, { $set: { 'plan.$.notified': text } })

  const from = schedule.notifyFrom ? await HubMember.findOne({ email: schedule.notifyFrom }).lean() : null
  if (!from?.gmail?.refreshToken) {
    return note(`Not emailed: ${schedule.notifyFrom || 'no sender set'} has no Gmail connected.`)
  }
  const to = await HubMember.findOne({ email: entry.email }).lean()
  const runs = await BwcResearchRun.find({ _id: { $in: entry.runIds?.length ? entry.runIds : [entry.runId] } })
    .sort({ startedAt: 1 })
    .lean()
  if (!runs.length) return note('Not emailed: run missing.')

  const { subject, text, found } = buildLeadsEmail({ rows: runs.flatMap((run) => runFindingsRows(run)), to, entry, day, from })
  if (!found) return note('Not emailed: no leads to send.')
  const cc = (schedule.notifyCc || []).filter((address) => address && address !== entry.email)
  const id = await sendAsMember(from, {
    to: entry.email,
    cc,
    subject,
    text,
    fromName: from.name || '',
  })
  return note(`Emailed from ${from.gmail.address}${cc.length ? `, cc ${cc.join(', ')}` : ''} (${id}).`)
}

/** When the schedule next fires, for the board. */
export function nextFireAt(schedule) {
  const { date, minutes } = localNow(schedule.timezone)
  const target = schedule.hour * 60 + schedule.minute
  // Walk forward from midnight of today (local) to find the next occurrence.
  const [y, m, d] = date.split('-').map(Number)
  const dayOffset = minutes < target ? 0 : 1
  // Build the instant by probing: start at the UTC date and adjust by the
  // zone's offset at that moment. Good to the minute across DST.
  const guess = new Date(Date.UTC(y, m - 1, d + dayOffset, schedule.hour, schedule.minute))
  const local = localNow(schedule.timezone, guess)
  let drift = local.minutes - target
  // The zone offset never exceeds twelve hours, so a larger drift is the
  // same offset seen across midnight.
  if (drift > 720) drift -= 1440
  if (drift < -720) drift += 1440
  return new Date(guess.getTime() - drift * 60 * 1000)
}

let ticking = false
/** Tick once a minute for the life of the process. */
export function startDailyResearchScheduler() {
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      await advance()
    } catch (error) {
      console.error(`[daily-research] tick failed: ${error?.message || error}`)
    } finally {
      ticking = false
    }
  }
  setInterval(() => void tick(), TICK_MS).unref()
  setTimeout(() => void tick(), 10 * 1000).unref()
  console.log('[daily-research] scheduler ticking every minute.')
}

/** Recent mornings, newest first, for the board. */
export const recentDays = (limit = 14) =>
  DailyResearchDay.find({}).sort({ date: -1 }).limit(limit).lean()
