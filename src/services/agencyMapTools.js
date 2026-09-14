import LeAgency from '../models/LeAgency.js'
import BwcResearchRun from '../models/BwcResearchRun.js'
import { buildCallReportStats, resolvePeriod } from './callReport.js'
import { buildFilter, describeFilters } from './leAgencyFilters.js'

/**
 * The Agency Map, read-only, for the hub MCP server.
 *
 * Everything here answers a question the map already answers for a person --
 * call activity by SDR, who rang whom, which agencies match a territory, what
 * the research runs found. Nothing here starts a run, logs a call or edits an
 * agency: a run costs money per agency and is gated to full-access accounts,
 * and a cron with write access to the call log could quietly rewrite the
 * record the SDR team is managed by.
 */

// The SDR team calls Texas and its neighbours. A bare "today" from Hermes means
// their today, not UTC's, which would drop every call made after 7pm Central.
export const DEFAULT_MAP_TIMEZONE = process.env.HUB_MCP_TIMEZONE || 'America/Chicago'

const MAX_CALLS = 200
const MAX_AGENCIES = 100
const MAX_RUNS = 50

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The filter builder reads query-string shapes (strings, 'true'/'false'), so
// tool arguments are coerced to that before they reach it.
function toQuery(args = {}) {
  const query = {}
  const strings = ['state', 'agencyType', 'search', 'stage', 'crm', 'bwc', 'bwcVendor']
  for (const key of strings) {
    if (args[key] !== undefined && args[key] !== null && String(args[key]).trim()) query[key] = String(args[key]).trim()
  }
  if (Number.isFinite(args.minOfficers)) query.minOfficers = String(args.minOfficers)
  if (Number.isFinite(args.maxOfficers)) query.maxOfficers = String(args.maxOfficers)
  return query
}

function period(args = {}) {
  return {
    from: typeof args.from === 'string' ? args.from : '',
    to: typeof args.to === 'string' ? args.to : '',
    timezone: typeof args.timezone === 'string' && args.timezone.trim() ? args.timezone : DEFAULT_MAP_TIMEZONE,
  }
}

/** Call activity for a territory and window: the same numbers as the call report PDF. */
export async function mapCallActivity(args = {}) {
  const query = toQuery(args)
  const stats = await buildCallReportStats({ filter: buildFilter(query), ...period(args) })
  return { scope: describeFilters(query), ...stats }
}

/** Individual calls, newest first, optionally one SDR's. */
export async function mapRecentCalls(args = {}) {
  const { from, to, timezone } = resolvePeriod(period(args))
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), MAX_CALLS)
  const scope = { ...buildFilter(toQuery(args)), isTestRecord: { $ne: true }, 'outreach.callCount': { $gt: 0 } }
  const inWindow = { 'callLog.calledAt': { $gte: from, $lte: to } }
  if (typeof args.sdr === 'string' && args.sdr.trim()) {
    inWindow['callLog.loggedBy'] = { $regex: escapeRegex(args.sdr.trim()), $options: 'i' }
  }
  const rows = await LeAgency.aggregate([
    { $match: scope },
    { $project: { ori: 1, agencyName: 1, state: 1, county: 1, callLog: 1 } },
    { $unwind: '$callLog' },
    { $match: inWindow },
    { $sort: { 'callLog.calledAt': -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        ori: 1,
        agencyName: 1,
        state: 1,
        county: 1,
        calledAt: '$callLog.calledAt',
        contactName: '$callLog.contactName',
        contactTitle: '$callLog.contactTitle',
        outcome: '$callLog.outcome',
        followUpAt: '$callLog.followUpAt',
        notes: '$callLog.notes',
        loggedBy: '$callLog.loggedBy',
      },
    },
  ])
  return { period: { from, to, timezone }, sdr: args.sdr || '', count: rows.length, limit, calls: rows }
}

const AGENCY_FIELDS =
  'ori agencyName agencyType state county employment.swornOfficers crm.matched crm.stage ' +
  'surveillance.bwc.status surveillance.bwc.vendor surveillance.bwc.trustedResearched ' +
  'contacts.chiefName contacts.chiefTitle contacts.phone contacts.email contacts.website outreach'

function compactAgency(agency) {
  return {
    ori: agency.ori,
    name: agency.agencyName,
    type: agency.agencyType || '',
    state: agency.state || '',
    county: agency.county || '',
    swornOfficers: agency.employment?.swornOfficers ?? null,
    crm: { matched: Boolean(agency.crm?.matched), stage: agency.crm?.stage || '' },
    bodyCameras: {
      status: agency.surveillance?.bwc?.trustedResearched || agency.surveillance?.bwc?.status || 'unknown',
      vendor: agency.surveillance?.bwc?.vendor || '',
    },
    chief: agency.contacts?.chiefName
      ? { name: agency.contacts.chiefName, title: agency.contacts.chiefTitle || '' }
      : null,
    phone: agency.contacts?.phone || '',
    email: agency.contacts?.email || '',
    website: agency.contacts?.website || '',
    outreach: agency.outreach || { callCount: 0, lastCalledAt: null, lastOutcome: '', lastLoggedBy: '' },
  }
}

/** Agencies matching the map's filters, biggest first. */
export async function mapSearchAgencies(args = {}) {
  const query = toQuery(args)
  const filter = { ...buildFilter(query), isTestRecord: { $ne: true } }
  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), MAX_AGENCIES)
  const [agencies, total] = await Promise.all([
    LeAgency.find(filter)
      .select(AGENCY_FIELDS)
      .sort({ 'employment.swornOfficers': -1, agencyName: 1 })
      .limit(limit)
      .lean(),
    LeAgency.countDocuments(filter),
  ])
  return { scope: describeFilters(query), total, returned: agencies.length, agencies: agencies.map(compactAgency) }
}

/** One agency with its full call log, newest call first. */
export async function mapAgency(args = {}) {
  const ori = String(args.ori || '').trim().toUpperCase()
  if (!ori) return null
  const agency = await LeAgency.findOne({ ori }).select(`${AGENCY_FIELDS} callLog contacts.mailingAddress`).lean()
  if (!agency) return null
  const calls = [...(agency.callLog || [])]
    .sort((a, b) => new Date(b.calledAt || b.loggedAt || 0) - new Date(a.calledAt || a.loggedAt || 0))
    .map(({ _id, ...call }) => call)
  return { ...compactAgency(agency), mailingAddress: agency.contacts?.mailingAddress || '', calls }
}

/** Research runs, newest first -- what each found, never what it is doing. */
export async function mapResearchRuns(args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), MAX_RUNS)
  const runs = await BwcResearchRun.find({})
    .select('-path -queue -current -leaseId -leaseExpiresAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
  return runs.map((run) => ({
    id: String(run._id),
    status: run.status,
    brief: run.brief || '',
    filtersLabel: run.filtersLabel || '',
    total: run.total,
    completed: run.completed,
    failed: run.failed,
    searches: run.searches,
    foundCameras: run.foundCameras,
    foundEmails: run.foundEmails,
    foundPhones: run.foundPhones,
    startedBy: run.startedBy || '',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastError: run.lastError || '',
  }))
}
