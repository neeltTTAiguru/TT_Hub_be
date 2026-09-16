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
const PLOTTABLE = { $or: [{ geo: { $exists: true } }, { 'location.geo': { $exists: true } }] }
const NOT_RESEARCHED = {
  'enrichment.bwcResearchedAt': null,
  'surveillance.bwc.trustedResearched': { $nin: ['has_bwc', 'no_bwc'] },
}

const me = `${os.hostname()}:${process.pid}`

const DEFAULT_PICK = { states: [], agencyTypes: [], maxOfficers: 25, camera: 'unknown' }
const PICK_CAMERA = { unknown: 'unknown', not_yes: 'not_yes', any: null }

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
      camera: pick.camera in PICK_CAMERA ? pick.camera : 'unknown',
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
  const query = {}
  const camera = PICK_CAMERA[pick.camera] === undefined ? 'unknown' : PICK_CAMERA[pick.camera]
  if (camera) query.bwc = camera
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
 * Start one entry: pick, run, assign. The entry must already be ours (status
 * 'starting'); on any failure it is marked and the plan moves on.
 */
async function startEntry(day, entry) {
  const member = await HubMember.findOne({ email: entry.email }).lean()
  const mark = (set) =>
    DailyResearchDay.updateOne({ _id: day._id, 'plan.email': entry.email }, { $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`plan.$.${k}`, v])) })

  if (!member) return mark({ status: 'skipped', note: 'No longer on the board.', finishedAt: new Date() })

  const { query, where } = pickFilter(await getSchedule())
  // Re-read at the moment of the draw, not at the start of the morning, so
  // the entry before this one - just finished - is already excluded.
  const taken = await everQueued()
  const picked = await LeAgency.aggregate([
    { $match: { $and: [where, { ori: { $nin: taken } }] } },
    { $sample: { size: entry.count } },
    { $project: { ori: 1 } },
  ])
  const oris = picked.map((row) => row.ori)
  if (!oris.length) {
    return mark({ status: 'skipped', note: 'Nothing left to pick: every agency in the pick scope is researched or has a known camera status.', finishedAt: new Date() })
  }

  const label = describeFilters(query)
  const run = await startRun({
    oris,
    brief: `Daily research for ${member.name || member.email}: ${oris.length} random agencies, ${label}.`,
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

  return mark({ status: 'running', runId: String(run._id), queued: oris.length, startedAt: new Date() })
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

  // Settle whatever was running.
  const running = day.plan.find((entry) => entry.status === 'running')
  if (running) {
    const run = await BwcResearchRun.findById(running.runId).select('status').lean()
    if (!run || ['done', 'stopped', 'failed'].includes(run.status)) {
      const settled = await DailyResearchDay.updateOne(
        { _id: day._id, 'plan.email': running.email, 'plan.status': 'running' },
        { $set: { 'plan.$.status': run?.status === 'failed' ? 'failed' : 'done', 'plan.$.finishedAt': new Date() } },
      )
      // Only the process that flipped it tells them, so two backends
      // ticking against the same plan send one email, not two.
      if (settled.modifiedCount && run) {
        await notifyLeadsReady(day, running, schedule).catch((error) =>
          console.error(`[daily-research] could not email ${running.email}: ${error?.message || error}`),
        )
      }
      day = await DailyResearchDay.findById(day._id)
    } else {
      return day
    }
  }

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
  const run = await BwcResearchRun.findById(entry.runId).lean()
  if (!run) return note('Not emailed: run missing.')

  const rows = runFindingsRows(run)
  const researched = rows.filter((row) => row.cameras !== 'Not researched')
  // Found to have cameras: ruled out, not a lead. Mentioned as a count only.
  const ruledOut = researched.filter((row) => row.cameras === 'Yes').length
  const found = researched.filter((row) => row.cameras !== 'Yes')
  const withEmail = found.filter((row) => row.email).length
  const withPhone = found.filter((row) => row.phone).length
  const firstName = (to?.name || entry.email.split('@')[0]).split(/\s+/)[0]
  const hub = (process.env.HUB_FRONTEND_URL?.trim() || 'http://localhost:5173').replace(/\/$/, '')

  const line = (row) => {
    const where = [row.county ? `${row.county} County` : '', row.state].filter(Boolean).join(', ')
    const who = row.chief ? `${row.chief}${row.chiefTitle ? `, ${row.chiefTitle}` : ''}` : 'decision maker not found'
    const reach = [row.phone, row.email].filter(Boolean).join(' · ') || 'no contact found'
    const cams = row.cameras === 'No' ? 'confirmed no cameras' : 'cameras unknown'
    return `- ${row.agency}${where ? ` (${where})` : ''}\n    ${who}\n    ${reach}\n    ${cams}`
  }

  const text = [
    `Hi ${firstName},`,
    '',
    `The traveller researched ${researched.length} agencies for you overnight and found ${found.length} new leads. They are on your map now, on top of your Texas list.`,
    '',
    `${withEmail} have an email address and ${withPhone} have a phone number.${ruledOut ? ` ${ruledOut} turned out to already have cameras and were left off.` : ''}`,
    '',
    `Open the map: ${hub}/agency-map`,
    '',
    `Your new leads (${day.date}):`,
    ...found.map(line),
    ...(rows.length > found.length ? ['', `${rows.length - found.length} could not be researched and will be retried another day.`] : []),
    '',
    `Sent by the Smart Hub on behalf of ${from.name || from.email}.`,
  ].join('\n')

  const cc = (schedule.notifyCc || []).filter((address) => address && address !== entry.email)
  const id = await sendAsMember(from, {
    to: entry.email,
    cc,
    subject: `${found.length} new leads on your map - ${day.date}`,
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
