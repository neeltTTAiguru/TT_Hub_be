import LeAgency from '../models/LeAgency.js'
import { chatWithHermes } from './hermesChat.js'

/**
 * Which outcomes mean a human actually talked to us.
 *
 * The distinction the whole report turns on: 200 dials and 200 voicemails is
 * not a week's work, and "calls made" alone cannot tell the two apart. Kept as
 * a set here rather than a guess in the PDF, because the same answer has to
 * come out of the numbers and out of the narrative.
 */
const CONVERSATION_OUTCOMES = [
  'Spoke with decision maker',
  'Spoke with gatekeeper',
  'Call back scheduled',
  'Asked for information by email',
  'Not interested',
]

/**
 * A call that reached nobody. Everything else is either a conversation or
 * unlabelled. "Call later" is the map's one-click deferral: the SDR looked at
 * the agency and put it off, which is work done but not a person reached.
 */
const UNREACHED_OUTCOMES = ['Left voicemail', 'No answer', 'Wrong number / bad line', 'Call later']

/**
 * An SDR is identified by the email they signed in with - except when Auth0
 * could not be asked for one, in which case the log holds an opaque subject
 * (`google-oauth2|1035...`). Printing that in a report tells a reader nothing
 * and, worse, reads as a second person. Name it for what it is instead.
 */
const repLabel = (loggedBy) => {
  const value = String(loggedBy || '').trim()
  if (!value) return 'Unattributed'
  return value.includes('@') ? value : 'Unidentified account'
}

const toDate = (value, fallback = null) => {
  const parsed = value ? new Date(value) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback
}

const DAY_MS = 24 * 60 * 60 * 1000
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A zone Intl recognises, so a typo from a browser cannot fail the aggregation. */
export function safeZone(timezone) {
  const zone = String(timezone || '').trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    return 'UTC'
  }
}

/** How far `zone` is from UTC at that instant, in milliseconds. */
function zoneOffsetMs(date, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  // Parts have no milliseconds, so measure against a date that has none either
  // - otherwise the offset carries a sub-second error and the end of the window
  // lands a second into the following day.
  return asUtc - (date.getTime() - date.getUTCMilliseconds())
}

/**
 * The instant a wall-clock day starts or ends in the reader's own timezone.
 *
 * "Calls on the 10th" means the 10th where the SDR is sitting. Resolving a bare
 * date with the server's clock instead put the boundary at 07:00 UTC and
 * silently dropped every call made after lunch today - the exact report someone
 * runs at four in the afternoon. The offset is applied twice because the first
 * pass is measured at the wrong instant when the day contains a DST change.
 */
function zonedBound(dateString, zone, endOfDay) {
  const wall = new Date(`${dateString}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
  let instant = new Date(wall.getTime() - zoneOffsetMs(wall, zone))
  instant = new Date(wall.getTime() - zoneOffsetMs(instant, zone))
  return instant
}

/**
 * The window the report covers, defaulting to the last 30 days.
 *
 * A bare `YYYY-MM-DD` is read as a whole day in `timezone`, because "the 8th to
 * the 10th" means through the end of the 10th to everybody who is not a
 * computer. A full ISO instant is taken as given - that is what the UI sends.
 */
export function resolvePeriod({ from, to, timezone } = {}) {
  const zone = safeZone(timezone)
  const end =
    typeof to === 'string' && BARE_DATE.test(to) ? zonedBound(to, zone, true) : toDate(to, new Date())
  const start =
    typeof from === 'string' && BARE_DATE.test(from)
      ? zonedBound(from, zone, false)
      : toDate(from, new Date(end.getTime() - 29 * DAY_MS))
  return { from: start, to: end, timezone: zone }
}

/** `YYYY-MM-DD` as it reads in `zone`, matching what $dateToString produced. */
function dayKey(date, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

/**
 * Every day in the window, including the ones nobody rang anybody.
 *
 * A chart built only from days that have calls draws a flat line of activity
 * across a fortnight where two days were worked, which is the opposite of what
 * the numbers say. Capped so that asking for a year does not produce 365 bars.
 */
function fillDays(rows, period, zone) {
  const counts = new Map(rows.map((row) => [row._id, row]))
  const spanDays = Math.round((period.to.getTime() - period.from.getTime()) / DAY_MS)
  if (spanDays > 92) {
    return rows.map((row) => ({ ...row, _id: row._id }))
  }
  const days = []
  // Stepping from noon keeps a DST shift from skipping or repeating a day.
  for (
    let cursor = new Date(period.from.getTime() + DAY_MS / 2);
    cursor.getTime() <= period.to.getTime() + DAY_MS / 2;
    cursor = new Date(cursor.getTime() + DAY_MS)
  ) {
    const key = dayKey(cursor, zone)
    if (days.length && days[days.length - 1]._id === key) continue
    days.push(counts.get(key) || { _id: key, calls: 0, agencies: [], conversations: 0 })
  }
  return days
}

/**
 * Every number in the report, counted in Mongo.
 *
 * Deliberately not asked of Hermes. He writes the words; a language model
 * adding up 64 calls by eye is how a report ends up saying something the table
 * beneath it contradicts. Same division as the traveller: the database knows,
 * the model phrases.
 *
 * `outreach.callCount` narrows the scan before the unwind - the map's filters
 * routinely match twenty thousand agencies and sixty of them have ever been
 * rung, and that denormalised counter exists precisely so we need not open the
 * other 19,940 logs to find out.
 */
export async function buildCallReportStats({ filter = {}, from, to, timezone = 'UTC' } = {}) {
  const period = resolvePeriod({ from, to, timezone })
  const zone = period.timezone
  const scope = { ...filter, isTestRecord: { $ne: true } }
  const called = { ...scope, 'outreach.callCount': { $gt: 0 } }
  const inWindow = { 'callLog.calledAt': { $gte: period.from, $lte: period.to } }

  const conversation = { $in: ['$callLog.outcome', CONVERSATION_OUTCOMES] }
  const countIf = (condition) => ({ $sum: { $cond: [condition, 1, 0] } })

  const [facets, agenciesInScope, firstContacts] = await Promise.all([
    LeAgency.aggregate([
      { $match: called },
      { $project: { ori: 1, agencyName: 1, state: 1, county: 1, callLog: 1 } },
      { $unwind: '$callLog' },
      { $match: inWindow },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                calls: { $sum: 1 },
                agencies: { $addToSet: '$ori' },
                reps: { $addToSet: '$callLog.loggedBy' },
                conversations: countIf(conversation),
                decisionMakers: countIf({ $eq: ['$callLog.outcome', 'Spoke with decision maker'] }),
                gatekeepers: countIf({ $eq: ['$callLog.outcome', 'Spoke with gatekeeper'] }),
                voicemails: countIf({ $eq: ['$callLog.outcome', 'Left voicemail'] }),
                noAnswer: countIf({ $eq: ['$callLog.outcome', 'No answer'] }),
                callbacks: countIf({ $eq: ['$callLog.outcome', 'Call back scheduled'] }),
                notInterested: countIf({ $eq: ['$callLog.outcome', 'Not interested'] }),
                badNumbers: countIf({ $eq: ['$callLog.outcome', 'Wrong number / bad line'] }),
                followUps: countIf({ $ne: ['$callLog.followUpAt', null] }),
                unlabelled: countIf({
                  $not: [
                    { $in: ['$callLog.outcome', [...CONVERSATION_OUTCOMES, ...UNREACHED_OUTCOMES]] },
                  ],
                }),
              },
            },
          ],
          byOutcome: [
            {
              $group: {
                _id: '$callLog.outcome',
                calls: { $sum: 1 },
                agencies: { $addToSet: '$ori' },
              },
            },
            { $sort: { calls: -1 } },
          ],
          byDay: [
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$callLog.calledAt', timezone: zone },
                },
                calls: { $sum: 1 },
                agencies: { $addToSet: '$ori' },
                conversations: countIf(conversation),
              },
            },
            { $sort: { _id: 1 } },
          ],
          byState: [
            {
              $group: {
                _id: '$state',
                calls: { $sum: 1 },
                agencies: { $addToSet: '$ori' },
                conversations: countIf(conversation),
              },
            },
            { $sort: { calls: -1 } },
            { $limit: 12 },
          ],
          byRep: [
            {
              $group: {
                _id: '$callLog.loggedBy',
                calls: { $sum: 1 },
                agencies: { $addToSet: '$ori' },
                conversations: countIf(conversation),
                decisionMakers: countIf({
                  $eq: ['$callLog.outcome', 'Spoke with decision maker'],
                }),
              },
            },
            { $sort: { calls: -1 } },
          ],
          topAgencies: [
            {
              $group: {
                _id: '$ori',
                name: { $first: '$agencyName' },
                state: { $first: '$state' },
                county: { $first: '$county' },
                calls: { $sum: 1 },
                conversations: countIf(conversation),
                lastCalledAt: { $max: '$callLog.calledAt' },
              },
            },
            { $sort: { calls: -1, lastCalledAt: -1 } },
            { $limit: 12 },
          ],
          followUps: [
            { $match: { 'callLog.followUpAt': { $ne: null } } },
            {
              $project: {
                _id: 0,
                ori: 1,
                name: '$agencyName',
                state: 1,
                followUpAt: '$callLog.followUpAt',
                outcome: '$callLog.outcome',
                contactName: '$callLog.contactName',
                loggedBy: '$callLog.loggedBy',
              },
            },
            { $sort: { followUpAt: 1 } },
            { $limit: 25 },
          ],
          // What was actually said, for the narrative. The counts say a call
          // happened; only the notes say the chief is out until the bond vote.
          notes: [
            { $match: { 'callLog.notes': { $nin: ['', null] } } },
            {
              $project: {
                _id: 0,
                name: '$agencyName',
                state: 1,
                outcome: '$callLog.outcome',
                calledAt: '$callLog.calledAt',
                contactName: '$callLog.contactName',
                contactTitle: '$callLog.contactTitle',
                notes: { $substrCP: ['$callLog.notes', 0, 400] },
              },
            },
            { $sort: { calledAt: -1 } },
            { $limit: 60 },
          ],
        },
      },
    ]),
    LeAgency.countDocuments(scope),
    // Agencies rung for the first time inside the window - the difference
    // between working new territory and re-working the same forty numbers.
    LeAgency.aggregate([
      { $match: called },
      { $project: { firstCalledAt: { $min: '$callLog.calledAt' } } },
      { $match: { firstCalledAt: { $gte: period.from, $lte: period.to } } },
      { $count: 'agencies' },
    ]),
  ])

  const facet = facets[0] || {}
  const raw = facet.totals?.[0] || null
  const size = (list) => (Array.isArray(list) ? list.length : 0)
  // Inclusive: a report covering the 8th to the 10th is three days of calling,
  // and dividing 34 calls by two of them would overstate the daily rate.
  const days = Math.max(
    1,
    Math.round((period.to.getTime() - period.from.getTime()) / DAY_MS) || 1,
  )

  const totals = {
    calls: raw?.calls || 0,
    agenciesCalled: size(raw?.agencies),
    agenciesInScope,
    firstContacts: firstContacts[0]?.agencies || 0,
    reps: size(raw?.reps),
    conversations: raw?.conversations || 0,
    decisionMakers: raw?.decisionMakers || 0,
    gatekeepers: raw?.gatekeepers || 0,
    voicemails: raw?.voicemails || 0,
    noAnswer: raw?.noAnswer || 0,
    callbacks: raw?.callbacks || 0,
    notInterested: raw?.notInterested || 0,
    badNumbers: raw?.badNumbers || 0,
    followUps: raw?.followUps || 0,
    unlabelled: raw?.unlabelled || 0,
    days,
    callsPerDay: raw?.calls ? Number((raw.calls / days).toFixed(1)) : 0,
    // Of the calls that were made, how many got a human. Reported against all
    // calls rather than against labelled ones: an SDR who leaves the outcome
    // blank has still spent the dial.
    connectRate: raw?.calls ? Math.round((raw.conversations / raw.calls) * 100) : 0,
  }

  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString(), days, timezone: zone },
    totals,
    byOutcome: (facet.byOutcome || []).map((row) => ({
      outcome: row._id || 'No outcome recorded',
      calls: row.calls,
      agencies: size(row.agencies),
    })),
    byDay: fillDays(facet.byDay || [], period, zone).map((row) => ({
      date: row._id,
      calls: row.calls,
      agencies: size(row.agencies),
      conversations: row.conversations,
    })),
    byState: (facet.byState || []).map((row) => ({
      state: row._id || 'Unknown',
      calls: row.calls,
      agencies: size(row.agencies),
      conversations: row.conversations,
    })),
    byRep: (facet.byRep || []).map((row) => ({
      rep: repLabel(row._id),
      calls: row.calls,
      agencies: size(row.agencies),
      conversations: row.conversations,
      decisionMakers: row.decisionMakers,
    })),
    topAgencies: (facet.topAgencies || []).map((row) => ({
      ori: row._id,
      name: row.name || '',
      state: row.state || '',
      county: row.county || '',
      calls: row.calls,
      conversations: row.conversations,
      lastCalledAt: row.lastCalledAt || null,
    })),
    followUps: (facet.followUps || []).map((row) => ({
      ...row,
      loggedBy: repLabel(row.loggedBy),
    })),
    notes: facet.notes || [],
  }
}

/** The stats as Hermes gets them - trimmed, so the notes are what he spends attention on. */
function statsForPrompt(stats, scopeLabel) {
  const day = (value) => new Date(value).toISOString().slice(0, 10)
  return JSON.stringify(
    {
      period: `${day(stats.period.from)} to ${day(stats.period.to)} (${stats.period.days} days)`,
      territory: scopeLabel || 'All agencies',
      totals: stats.totals,
      callsPerDay: stats.byDay,
      outcomes: stats.byOutcome,
      byState: stats.byState,
      bySdr: stats.byRep,
      mostWorkedAgencies: stats.topAgencies,
      followUpsBooked: stats.followUps,
      whatWasSaid: stats.notes,
    },
    null,
    1,
  )
}

const NARRATIVE_INSTRUCTIONS = [
  'You are writing the written half of a call activity report for the Trusted',
  'Technology SDR team. It goes to Kyle and Todd, who run the territory. They',
  'sell body-worn cameras and evidence management to small US police',
  'departments, sheriffs and constables.',
  '',
  'THE NUMBERS ARE ALREADY COUNTED. Every figure you need is in the JSON below,',
  'and the same figures are printed as tables directly beneath your words. Quote',
  'them, never recompute them, never round them into something else and never',
  'add up a column yourself. If a number is not in the JSON, it does not go in',
  'the report.',
  '',
  'The notes under whatWasSaid are what the SDR typed after each call. That is',
  'the only part of this report a table cannot show, so it is where most of your',
  'value is. Name specific agencies, specific people and specific reasons.',
  '"Several agencies mentioned budget" is worth nothing; "Pampa PD said the',
  'sheriff hosts their footage free, so price is not the lever there" is the',
  'whole point.',
  '',
  'Write plainly, in British-neutral business English, no exclamation marks, no',
  'sales language, no congratulating anybody. If the week was thin, say so.',
  '',
  'Reply with markdown and nothing else, using exactly these three headings:',
  '',
  '## Summary',
  'Three or four sentences: how much calling happened, how much of it reached a',
  'human, and what that says about the territory.',
  '',
  '## What the calls turned up',
  'Four to eight bullets drawn from the notes. Each names the agency and what',
  'was actually learned - who the gatekeeper is, which vendor they already run,',
  'when their budget lands, why they said no.',
  '',
  '## What to do next',
  'Three to five bullets. Concrete and assigned to an agency or a date where the',
  'notes support one. Follow-ups already booked come first.',
].join('\n')

/**
 * The narrative, or an empty string.
 *
 * Never throws: Hermes going down, timing out or being unconfigured must not
 * cost the reader the report. The numbers are the part that has to be right,
 * and they are already counted by the time this runs - a stats-only PDF is a
 * far better failure than a 503 on the download button.
 */
export async function generateCallReportNarrative(stats, options = {}) {
  if (!stats?.totals?.calls) return { narrative: '', error: 'No calls in this period.' }
  try {
    const reply = await chatWithHermes(
      process.env.CALL_REPORT_AGENT_ID || 'trusted-tech-assistant',
      [{ role: 'user', content: statsForPrompt(stats, options.scopeLabel) }],
      {
        instructions: NARRATIVE_INSTRUCTIONS,
        memoryContext: '',
        timeoutMs: Number(process.env.CALL_REPORT_TIMEOUT_MS || 120000),
        rateLimitRetries: 1,
      },
    )
    return { narrative: String(reply?.message?.content || '').trim(), error: '' }
  } catch (error) {
    return { narrative: '', error: error?.message || 'Hermes could not write the summary.' }
  }
}
