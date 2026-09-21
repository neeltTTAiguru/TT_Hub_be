import mongoose from 'mongoose'
import LeAgency from '../models/LeAgency.js'
import { resolvePeriod, safeZone } from './callReport.js'

/**
 * The call sheet: one row per call an SAE logged from the map.
 *
 * Calls are stored inside each agency's `callLog`, which is the right shape
 * for the map - "has anyone rung them" is answered next to the pin - and the
 * wrong shape for a manager. "What did Troy log on the 15th" is a question
 * about rows, not agencies, and answering it means unwinding 20,000 documents
 * by hand every time.
 *
 * So the same rows are published as a Mongo VIEW, `map_calls`, over the
 * agency collection. A view, not a second collection: nothing is copied and
 * nothing can drift, because there is nothing to keep in step. Every call the
 * map saves is in the sheet the moment it is saved, and a call removed from
 * the log is gone from the sheet. Query it in Atlas or Compass like any
 * collection, and the API below serves the same rows filtered by rep and date.
 */
export const MAP_CALL_SHEET_VIEW = 'map_calls'

/**
 * What one call is, for the sheet.
 *
 * Not every row in the log is a dial. "Call later" is the map's one-click
 * deferral and "Follow-up email sent" is an email; both live in the log
 * because they belong on the agency's timeline, but neither is a phone call
 * and a report that counts them as such overstates the week. `kind` names
 * which is which so a count can leave them out without knowing the outcome
 * strings by heart.
 */
export const CALL_KINDS = { CALL: 'call', EMAIL: 'email', BOOKMARK: 'bookmark' }

const kindExpression = {
  $switch: {
    branches: [
      { case: { $eq: ['$callLog.outcome', 'Follow-up email sent'] }, then: CALL_KINDS.EMAIL },
      { case: { $eq: ['$callLog.outcome', 'Call later'] }, then: CALL_KINDS.BOOKMARK },
    ],
    default: CALL_KINDS.CALL,
  },
}

/** The day a call belongs to, as the team reads it - not as the server's clock does. */
export const SHEET_TIMEZONE = safeZone(process.env.MAP_CALL_SHEET_TIMEZONE || 'America/Chicago')

/**
 * The view's definition. Also the first half of every query the API runs, so
 * a row means the same thing whichever way it was reached.
 *
 * Test agencies are left out: a rehearsal call that counts towards a rep's
 * week is worse than no rehearsal at all.
 */
export const MAP_CALL_SHEET_PIPELINE = [
  { $match: { isTestRecord: { $ne: true }, 'callLog.0': { $exists: true } } },
  { $unwind: '$callLog' },
  {
    $project: {
      _id: '$callLog._id',
      calledAt: '$callLog.calledAt',
      calledOn: {
        $dateToString: { format: '%Y-%m-%d', date: '$callLog.calledAt', timezone: SHEET_TIMEZONE },
      },
      loggedBy: '$callLog.loggedBy',
      loggedAt: '$callLog.loggedAt',
      kind: kindExpression,
      outcome: '$callLog.outcome',
      contactName: '$callLog.contactName',
      contactTitle: '$callLog.contactTitle',
      phone: '$callLog.phone',
      followUpAt: '$callLog.followUpAt',
      notes: '$callLog.notes',
      clientCallId: '$callLog.clientCallId',
      ori: '$ori',
      agencyName: '$agencyName',
      agencyType: '$agencyType',
      state: '$state',
      county: '$county',
      swornOfficers: '$employment.swornOfficers',
      crmStage: '$crm.stage',
      hubspotCompanyId: '$crm.hubspotCompanyId',
      hubspotContactId: '$crm.hubspotContactId',
      hubspotCallId: '$callLog.hubspotCallId',
      hubspotSyncedAt: '$callLog.hubspotSyncedAt',
      hubspotSyncError: '$callLog.hubspotSyncError',
    },
  },
]

/**
 * Create the view, or bring it up to date with the pipeline above.
 *
 * Run at boot and safe to run on every boot. A view carries no data, so when
 * its definition has changed it is dropped and made again rather than altered:
 * `collMod` needs a database-admin role the API's user does not have, and
 * should not have for the sake of a view. A view already matching the code is
 * left alone, so two backends sharing the database do not take turns
 * rebuilding it.
 */
export async function ensureMapCallSheet(db = mongoose.connection.db) {
  const source = LeAgency.collection.collectionName
  const wanted = JSON.stringify(MAP_CALL_SHEET_PIPELINE)
  const [existing] = await db.listCollections({ name: MAP_CALL_SHEET_VIEW }).toArray()
  if (existing) {
    const current = existing.options || {}
    if (current.viewOn === source && JSON.stringify(current.pipeline) === wanted) {
      return { view: MAP_CALL_SHEET_VIEW, action: 'unchanged' }
    }
    await db.dropCollection(MAP_CALL_SHEET_VIEW)
  }
  await db.createCollection(MAP_CALL_SHEET_VIEW, { viewOn: source, pipeline: MAP_CALL_SHEET_PIPELINE })
  return { view: MAP_CALL_SHEET_VIEW, action: existing ? 'rebuilt' : 'created' }
}

const clean = (value) => String(value ?? '').trim()
const cleanEmail = (value) => clean(value).toLowerCase()
const list = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((item) => clean(item))
    .filter(Boolean)

export const MAX_SHEET_ROWS = 5000

/**
 * The `$match` for a request: a window, and optionally who, what and where.
 *
 * `from`/`to` follow the call report's rules - a bare date is a whole day in
 * the caller's timezone - so the sheet and the report agree about which calls
 * are "this week". Reps are matched on the email they signed in with;
 * outcomes exactly as the map spells them.
 */
export function buildSheetQuery(input = {}) {
  const period = resolvePeriod({ from: input.from, to: input.to, timezone: input.timezone })
  const match = { calledAt: { $gte: period.from, $lte: period.to } }
  const reps = list(input.rep).map(cleanEmail)
  if (reps.length) match.loggedBy = reps.length === 1 ? reps[0] : { $in: reps }
  const outcomes = list(input.outcome)
  if (outcomes.length) match.outcome = outcomes.length === 1 ? outcomes[0] : { $in: outcomes }
  const kinds = list(input.kind).filter((kind) => Object.values(CALL_KINDS).includes(kind))
  if (kinds.length) match.kind = kinds.length === 1 ? kinds[0] : { $in: kinds }
  const oris = list(input.ori).map((ori) => ori.toUpperCase())
  if (oris.length) match.ori = oris.length === 1 ? oris[0] : { $in: oris }
  if (input.state) match.state = clean(input.state).toUpperCase()
  if (input.unsynced === true || input.unsynced === 'true') {
    // Never reached HubSpot, whatever the reason - including emails, which the
    // map does not send up at all. This is the reconciliation list.
    match.hubspotCallId = { $in: ['', null] }
    // Bookmarks are never sent, so they are not missing.
    if (!kinds.length) match.kind = { $ne: CALL_KINDS.BOOKMARK }
  }
  const limit = Math.min(Math.max(Number(input.limit) || MAX_SHEET_ROWS, 1), MAX_SHEET_ROWS)
  return { match, period, limit }
}

/**
 * The rows for a request, newest first.
 *
 * Aggregated over the agencies directly rather than read from the view, so
 * the API answers even on a database where the view could not be created.
 * The pipeline is the view's, so the answer is the same one Atlas would give.
 */
export async function listMapCalls(input = {}, scopeFilter = null) {
  const { match, period, limit } = buildSheetQuery(input)
  const pipeline = [...MAP_CALL_SHEET_PIPELINE]
  // A member's scope, when there is one, is a filter on agencies, and belongs
  // before the unwind where those fields still exist.
  if (scopeFilter && Object.keys(scopeFilter).length) pipeline.splice(1, 0, { $match: scopeFilter })
  pipeline.push({ $match: match }, { $sort: { calledAt: -1, _id: -1 } }, { $limit: limit + 1 })
  const rows = await LeAgency.aggregate(pipeline)
  const truncated = rows.length > limit
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated, limit, period }
}

/** The columns, in the order someone pasting into HubSpot wants them. */
export const SHEET_COLUMNS = [
  ['Date', (row) => row.calledOn || ''],
  ['Called at (UTC)', (row) => iso(row.calledAt)],
  ['Rep', (row) => row.loggedBy || ''],
  ['Agency', (row) => row.agencyName || ''],
  ['State', (row) => row.state || ''],
  ['ORI', (row) => row.ori || ''],
  ['Type', (row) => row.kind || ''],
  ['Outcome', (row) => row.outcome || ''],
  ['Contact', (row) => row.contactName || ''],
  ['Contact title', (row) => row.contactTitle || ''],
  ['Phone', (row) => row.phone || ''],
  ['Follow-up (UTC)', (row) => iso(row.followUpAt)],
  ['Notes', (row) => row.notes || ''],
  ['Sworn officers', (row) => row.swornOfficers ?? ''],
  ['HubSpot stage', (row) => row.crmStage || ''],
  ['HubSpot call ID', (row) => row.hubspotCallId || ''],
  ['HubSpot company ID', (row) => row.hubspotCompanyId || ''],
  ['HubSpot sync error', (row) => row.hubspotSyncError || ''],
  ['Map call ID', (row) => (row._id ? String(row._id) : '')],
]

const iso = (value) => {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : ''
}

/** RFC 4180: quote when needed, double the quotes, keep newlines inside notes. */
export const csvCell = (value) => {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function mapCallsToCsv(rows) {
  const lines = [SHEET_COLUMNS.map(([header]) => csvCell(header)).join(',')]
  for (const row of rows) {
    lines.push(SHEET_COLUMNS.map(([, read]) => csvCell(read(row))).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
