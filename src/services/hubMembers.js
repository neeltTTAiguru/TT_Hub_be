/**
 * The command board's rules, applied.
 *
 * Two jobs: keep the roster current (every sign-in is stamped), and turn a
 * member's configuration into the Mongo clause the map routes intersect with.
 * The clause is built by the same buildFilter the map's own query goes
 * through, so a scope of "TX, Sheriff, 25 or fewer" means exactly what those
 * filters mean when you set them by hand.
 */
import HubMember from '../models/HubMember.js'
import BwcResearchRun from '../models/BwcResearchRun.js'
import LeAgency from '../models/LeAgency.js'
import TravellerState from '../models/TravellerState.js'
import { hasFullAccess, resolveActorEmail } from '../middleware/featureAccess.js'
import { buildFilter } from './leAgencyFilters.js'

const CAMERA_TO_QUERY = { unknown: 'unknown', yes: 'true', no: 'false', not_yes: 'not_yes' }

/** Record that this email signed in. Never throws - it is on the sign-in path. */
export async function touchMember(email, name = '') {
  if (!email) return
  try {
    await HubMember.updateOne(
      { email },
      { $set: { lastSeenAt: new Date(), ...(name ? { name } : {}) }, $setOnInsert: { email } },
      { upsert: true },
    )
  } catch (error) {
    console.error(`[hub-members] could not stamp ${email}: ${error?.message || error}`)
  }
}

/**
 * Put everyone who has ever used the hub on the roster.
 *
 * Sign-ins are only stamped from today, but the people who matter have been
 * here for months: they logged calls and have a traveller. Those records name
 * them, so the board can list them without waiting for each to sign in again.
 * Upserts the email only - a person already on the board keeps their rules.
 */
export async function seedRosterFromActivity() {
  try {
    const [callers, travellers, runners] = await Promise.all([
      LeAgency.distinct('callLog.loggedBy', { 'callLog.loggedBy': { $regex: '@' } }),
      TravellerState.distinct('email', { email: { $regex: '@' } }),
      BwcResearchRun.distinct('startedBy', { startedBy: { $regex: '@' } }),
    ])
    const emails = [...new Set([...callers, ...travellers, ...runners].map((e) => String(e).trim().toLowerCase()))]
    if (!emails.length) return
    await HubMember.bulkWrite(
      emails.map((email) => ({
        updateOne: { filter: { email }, update: { $setOnInsert: { email } }, upsert: true },
      })),
      { ordered: false },
    )
  } catch (error) {
    console.error(`[hub-members] roster seed failed: ${error?.message || error}`)
  }
}

/**
 * The runs a member sees: their own, plus everything assigned to anyone they
 * are covering for while that switch is on. Resolved fresh each time - the
 * board can flip it at any moment, and stale cover is someone seeing leads
 * they were just told are not theirs any more.
 */
export async function effectiveRunIds(member) {
  const own = (member?.assignedRunIds || []).map(String)
  const covering = (member?.coveringFor || []).map((e) => String(e).toLowerCase()).filter(Boolean)
  if (!covering.length) return own
  const covered = await HubMember.find({ email: { $in: covering } }).select('assignedRunIds').lean()
  return [...new Set([...own, ...covered.flatMap((m) => (m.assignedRunIds || []).map(String))])]
}

/** The ORIs every assigned run covered, as one set. */
async function assignedOris(runIds = []) {
  if (!runIds.length) return []
  const runs = await BwcResearchRun.find({ _id: { $in: runIds } })
    .select('queue')
    .lean()
  return [...new Set(runs.flatMap((run) => run.queue || []))]
}

/**
 * The clause a member's map is intersected with, or null for no limit.
 *
 * Rebuilt per request rather than cached: a run's queue never changes after
 * it starts, but the board can change at any moment and a stale scope is a
 * person seeing what they were just told they cannot.
 */
export async function scopeClauseFor(member) {
  if (!member) return null
  const scope = member.scope || {}
  const query = {}
  if (scope.states?.length) query.state = scope.states.join(',')
  if (scope.agencyTypes?.length) query.agencyType = scope.agencyTypes.join(',')
  if (Number.isFinite(scope.maxOfficers)) query.maxOfficers = String(scope.maxOfficers)
  if (CAMERA_TO_QUERY[scope.camera]) query.bwc = CAMERA_TO_QUERY[scope.camera]

  const built = buildFilter(query)
  const hasScope = Object.keys(built).length > 0
  const runIds = await effectiveRunIds(member)

  // Everything researched for them - including what the research found to
  // have cameras. Those stay on the map as red pins rather than vanishing:
  // a lead that turns red is an answer the person should see, not a gap.
  const theirs = async () => ({ ori: { $in: await assignedOris(runIds) } })

  const always = await alwaysClauseFor(member)
  const plus = (clause) => (always ? { $or: [clause, always] } : clause)

  // Only their runs: an empty worklist when none are assigned, not the
  // whole country. $in [] matches nothing, which is the honest answer.
  if (member.limitToAssignedRuns) return plus(await theirs())
  if (!hasScope) return null
  // Their scope is what they are working; anything researched for them sits
  // on top of it whatever state or size it is in.
  if (!runIds.length) return plus(built)
  return plus({ $or: [built, await theirs()] })
}

/**
 * What is on a member's map no matter what filter the map itself applies.
 *
 * The map opens on the scope's state and a size ceiling and sends those as
 * its own filter. Intersected with the scope alone, that dropped everything
 * researched for the person outside that state: Kyle's morning draw is
 * national, his scope is Texas, and most of his leads were on his list but
 * not on his map - "Show on map" had nothing to show. These bypass the
 * map's filter entirely (see `scoped`).
 */
export async function alwaysClauseFor(member) {
  const parts = []
  const runIds = await effectiveRunIds(member)
  // Researched for them - camera or not; found-to-have-cameras shows red.
  if (runIds.length) parts.push({ ori: { $in: await assignedOris(runIds) } })
  // Every agency with a call logged, whoever logged it: the Reached out and
  // Call later pins. Callable follow-ups, not leads, so no camera filter.
  if (member?.includeCalled) parts.push({ 'outreach.callCount': { $gt: 0 } })
  if (!parts.length) return null
  return parts.length === 1 ? parts[0] : { $or: parts }
}

/**
 * Express middleware: work out the caller's scope once, for the routes below.
 *
 * Full-access accounts get no scope. Everyone else gets their member record's,
 * which is nothing at all until the board says otherwise. Fails open on a
 * lookup error - the map's baseline is "everyone signed in sees it", and a
 * database blip should not turn that into a blank page.
 */
export async function withMemberScope(req, res, next) {
  req.member = null
  req.memberScope = null
  if (req.method === 'OPTIONS') return next()
  try {
    const email = await resolveActorEmail(req)
    if (!email || hasFullAccess(email)) return next()
    const member = await HubMember.findOne({ email }).lean()
    if (!member) return next()
    req.member = member
    req.memberRunIds = await effectiveRunIds(member)
    req.memberScope = await scopeClauseFor(member)
    req.memberAlways = await alwaysClauseFor(member)
  } catch (error) {
    console.error(`[hub-members] scope lookup failed: ${error?.message || error}`)
  }
  return next()
}

/**
 * Intersect a route's own filter with the caller's scope, if they have one -
 * except for what is always theirs, which the route's filter must not hide.
 */
export const scoped = (req, filter) => {
  if (!req.memberScope) return filter
  const within = { $and: [filter, req.memberScope] }
  return req.memberAlways ? { $or: [within, req.memberAlways] } : within
}

/**
 * The run ids a member may see, or null for all of them.
 *
 * Only a member limited to their assigned runs is limited here: a member with
 * assignments but a free map still watches every run, as they always could.
 */
export const visibleRunIds = (req) =>
  req.member?.limitToAssignedRuns ? req.memberRunIds || (req.member.assignedRunIds || []).map(String) : null

/** What the client needs to draw a member's map: their rules and their runs. */
export async function memberViewFor(member) {
  if (!member) return null
  const runs = await BwcResearchRun.find({ _id: { $in: await effectiveRunIds(member) } })
    .select('status brief filtersLabel total completed failed startedAt finishedAt assignedTo')
    .sort({ startedAt: -1 })
    .lean()
  // A name for "covering for", where one is on the board.
  const owners = await HubMember.find({ email: { $in: runs.map((r) => r.assignedTo).filter(Boolean) } })
    .select('email name')
    .lean()
  const nameOf = (email) => owners.find((o) => o.email === email)?.name || (email || '').split('@')[0]
  return {
    assignedRuns: runs.map((run) => ({
      id: String(run._id),
      status: run.status,
      assignedTo: run.assignedTo || '',
      // Set when this run is somebody else's, on this board because this
      // person is covering for them.
      coveringFor:
        run.assignedTo && run.assignedTo.toLowerCase() !== member.email.toLowerCase() ? nameOf(run.assignedTo) : '',
      brief: run.brief || '',
      filtersLabel: run.filtersLabel || '',
      total: run.total,
      completed: run.completed,
      failed: run.failed,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    limitToAssignedRuns: Boolean(member.limitToAssignedRuns),
    includeCalled: Boolean(member.includeCalled),
    scope: {
      states: member.scope?.states || [],
      agencyTypes: member.scope?.agencyTypes || [],
      maxOfficers: Number.isFinite(member.scope?.maxOfficers) ? member.scope.maxOfficers : null,
      camera: member.scope?.camera || 'any',
    },
  }
}
