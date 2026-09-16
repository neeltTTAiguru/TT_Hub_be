import { Router } from 'express'
import HubMember from '../models/HubMember.js'
import BwcResearchRun from '../models/BwcResearchRun.js'
import LeAgency from '../models/LeAgency.js'
import { fullAccessEmails, requireFullAccess } from '../middleware/featureAccess.js'
import { resolveActor } from '../middleware/auth.js'
import { memberViewFor, scopeClauseFor, seedRosterFromActivity } from '../services/hubMembers.js'
import {
  advance,
  getSchedule,
  nextFireAt,
  poolSize,
  recentDays,
  saveSchedule,
} from '../services/dailyResearch.js'

const router = Router()

/**
 * The command board: who signs in to the hub, and what each of them sees.
 *
 * Full-access only, every route. The board decides what restricted accounts
 * are shown, so a restricted account editing it would be deciding for itself.
 */
router.use(requireFullAccess)

const CAMERA = new Set(['any', 'unknown', 'yes', 'no', 'not_yes'])

const asMember = (doc) => ({
  email: doc.email,
  name: doc.name || '',
  lastSeenAt: doc.lastSeenAt || null,
  fullAccess: fullAccessEmails().includes(doc.email),
  assignedRunIds: (doc.assignedRunIds || []).map(String),
  limitToAssignedRuns: Boolean(doc.limitToAssignedRuns),
  dailyResearch: Number.isFinite(doc.dailyResearch) ? doc.dailyResearch : 0,
  gmail: { connected: Boolean(doc.gmail?.refreshToken), address: doc.gmail?.address || '' },
  scope: {
    states: doc.scope?.states || [],
    agencyTypes: doc.scope?.agencyTypes || [],
    maxOfficers: Number.isFinite(doc.scope?.maxOfficers) ? doc.scope.maxOfficers : null,
    camera: doc.scope?.camera || 'any',
  },
  notes: doc.notes || '',
  updatedBy: doc.updatedBy || '',
  updatedAt: doc.updatedAt || null,
})

/** Everyone on the roster, every run they could be given, and the option lists. */
router.get('/', async (req, res, next) => {
  try {
    await seedRosterFromActivity()
    const [members, runs, agencyTypes, schedule, days] = await Promise.all([
      HubMember.find({}).sort({ lastSeenAt: -1, email: 1 }).lean(),
      BwcResearchRun.find({})
        .select('status brief filtersLabel total completed failed foundCameras foundEmails foundPhones startedAt finishedAt startedBy assignedTo')
        .sort({ startedAt: -1 })
        .limit(300)
        .lean(),
      LeAgency.distinct('agencyType', { isTestRecord: { $ne: true } }),
      getSchedule(),
      recentDays(7),
    ])
    // How many unknown-camera agencies are left to draw from, so a daily total
    // bigger than the pool is visible before the morning it comes up short.
    const pool = await poolSize(schedule)
    res.json({
      members: members.map(asMember),
      runs: runs.map((run) => ({
        id: String(run._id),
        status: run.status,
        brief: run.brief || '',
        filtersLabel: run.filtersLabel || '',
        total: run.total,
        completed: run.completed,
        failed: run.failed,
        foundCameras: run.foundCameras || 0,
        foundEmails: run.foundEmails || 0,
        foundPhones: run.foundPhones || 0,
        startedBy: run.startedBy || '',
        assignedTo: run.assignedTo || '',
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })),
      agencyTypes: agencyTypes.filter(Boolean).sort(),
      fullAccessEmails: fullAccessEmails(),
      schedule: {
        enabled: Boolean(schedule.enabled),
        hour: schedule.hour,
        minute: schedule.minute,
        timezone: schedule.timezone,
        pick: schedule.pick,
        notifyFrom: schedule.notifyFrom || '',
        pool,
        nextFireAt: schedule.enabled ? nextFireAt(schedule) : null,
        days: days.map((day) => ({
          date: day.date,
          trigger: day.trigger,
          finishedAt: day.finishedAt,
          plan: day.plan,
        })),
      },
    })
  } catch (error) {
    next(error)
  }
})

/** Create or update one person's rules. The whole configuration, every time. */
router.put('/members/:email', async (req, res, next) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase()
    if (!email.includes('@')) return res.status(400).json({ message: 'That is not an email address.' })
    const body = req.body || {}

    const runIds = Array.isArray(body.assignedRunIds)
      ? [...new Set(body.assignedRunIds.map(String).filter((id) => /^[a-f0-9]{24}$/i.test(id)))]
      : []
    // Only runs that exist. A stale id would silently be an empty worklist.
    const known = new Set(
      (await BwcResearchRun.find({ _id: { $in: runIds } }).select('_id').lean()).map((r) => String(r._id)),
    )

    const scope = body.scope || {}
    const list = (value, upper = false) =>
      Array.isArray(value)
        ? [...new Set(value.map((v) => String(v).trim()).map((v) => (upper ? v.toUpperCase() : v)).filter(Boolean))]
        : []
    const maxOfficers = Number(scope.maxOfficers)
    const daily = Number(body.dailyResearch)

    const set = {
      name: String(body.name || '').slice(0, 120),
      assignedRunIds: runIds.filter((id) => known.has(id)),
      limitToAssignedRuns: body.limitToAssignedRuns === true,
      dailyResearch: Number.isFinite(daily) && daily > 0 ? Math.min(Math.floor(daily), 500) : 0,
      scope: {
        states: list(scope.states, true),
        agencyTypes: list(scope.agencyTypes),
        maxOfficers: Number.isFinite(maxOfficers) && maxOfficers > 0 ? Math.floor(maxOfficers) : null,
        camera: CAMERA.has(scope.camera) ? scope.camera : 'any',
      },
      notes: String(body.notes || '').slice(0, 1000),
      updatedBy: await resolveActor(req),
    }

    const doc = await HubMember.findOneAndUpdate(
      { email },
      { $set: set, $setOnInsert: { email } },
      { upsert: true, new: true },
    ).lean()
    res.json(asMember(doc))
  } catch (error) {
    next(error)
  }
})

/** Switch the morning schedule on or off, or move the hour. */
router.put('/schedule', async (req, res, next) => {
  try {
    const body = req.body || {}
    const schedule = await saveSchedule({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      hour: Number.isInteger(body.hour) ? body.hour : undefined,
      minute: Number.isInteger(body.minute) ? body.minute : undefined,
      pick: body.pick,
      notifyFrom: typeof body.notifyFrom === 'string' ? body.notifyFrom : undefined,
      updatedBy: await resolveActor(req),
    })
    res.json({ ...schedule, nextFireAt: schedule.enabled ? nextFireAt(schedule) : null })
  } catch (error) {
    next(error)
  }
})

/**
 * Run today's plan now rather than at the hour. Spends today's budget; a day
 * that already ran is not run again - the answer then is the day as it went.
 */
router.post('/schedule/run-now', async (req, res, next) => {
  try {
    const day = await advance({ force: true })
    if (!day) return res.status(409).json({ message: 'Nobody has a daily number set.' })
    return res.json({ date: day.date, trigger: day.trigger, finishedAt: day.finishedAt, plan: day.plan })
  } catch (error) {
    return next(error)
  }
})

/** Take someone off the board. They can still sign in; they just see the default map. */
router.delete('/members/:email', async (req, res, next) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase()
    const result = await HubMember.deleteOne({ email })
    if (!result.deletedCount) return res.status(404).json({ message: 'Nobody on the board with that email.' })
    return res.json({ ok: true })
  } catch (error) {
    return next(error)
  }
})

/** Preview: what one member's map would contain under their current rules. */
router.get('/members/:email/preview', async (req, res, next) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase()
    const member = await HubMember.findOne({ email }).lean()
    if (!member) return res.status(404).json({ message: 'Nobody on the board with that email.' })
    const clause = await scopeClauseFor(member)
    const count = await LeAgency.countDocuments({
      ...(clause ? { $and: [clause, { isTestRecord: { $ne: true } }] } : { isTestRecord: { $ne: true } }),
    })
    return res.json({ agencies: count, limited: Boolean(clause), view: await memberViewFor(member) })
  } catch (error) {
    return next(error)
  }
})

export default router
