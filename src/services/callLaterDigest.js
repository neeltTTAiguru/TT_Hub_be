/**
 * The Friday call-later email: the pink pins still waiting for a ring-back.
 *
 * A voicemail or a "call later" puts an agency back in somebody's hands, and
 * the calendar books the one call-back that was promised - but a list of every
 * agency still owed a call is what the person working them plans a week from.
 * This sends that list, most overdue first, to the call-back owner (Kyle).
 *
 * Driven by the daily-research tick rather than a timer of its own, so
 * DAILY_RESEARCH_SCHEDULER=off silences it on the laptop too, and uses the same
 * timezone and sender as the morning leads email.
 */
import os from 'node:os'
import CallLaterDigestSend from '../models/CallLaterDigestSend.js'
import HubMember from '../models/HubMember.js'
import LeAgency from '../models/LeAgency.js'
import { callBackOwnerEmail } from './calendar.js'
import { getSchedule, localNow } from './dailyResearch.js'
import { sendAsMember } from './gmail.js'

/** The outcomes that turn a pin pink. Matches CALL_LATER_OUTCOMES on the map. */
export const CALL_LATER_OUTCOMES = ['Call later', 'Left voicemail']

// A Friday send that was missed (the backend down at seven) still goes out
// later that morning; one missed by more than this waits for next week rather
// than landing in Kyle's inbox on Friday night.
const GRACE_MINUTES = 180

const DEFAULTS = { enabled: true, weekday: 5, hour: 7, minute: 0, to: '', cc: [], limit: 50 }

export const digestSettings = (schedule) => {
  const merged = { ...DEFAULTS, ...(schedule?.callLaterDigest || {}) }
  return {
    ...merged,
    to: (merged.to || callBackOwnerEmail()).toLowerCase(),
    cc: merged.cc || [],
    limit: Number.isFinite(merged.limit) && merged.limit > 0 ? Math.min(Math.floor(merged.limit), 200) : 50,
  }
}

const latestCall = (calls = []) =>
  [...calls].sort((a, b) => new Date(b.calledAt || b.loggedAt || 0) - new Date(a.calledAt || a.loggedAt || 0))[0] ||
  null

/**
 * Every agency whose latest call left it waiting, oldest promise first.
 *
 * "Oldest promise" is the follow-up date the caller set, or when there is none
 * the day of the call: a voicemail from three weeks ago with no date is more
 * overdue than one from yesterday. Only agencies with a pin - an agency that
 * cannot be drawn is not "on the map" - and never the test records.
 */
export async function callLaterAgencies() {
  const agencies = await LeAgency.find({
    'outreach.lastOutcome': { $in: CALL_LATER_OUTCOMES },
    isTestRecord: { $ne: true },
    $or: [{ geo: { $exists: true } }, { 'location.geo': { $exists: true } }],
  })
    .select('ori agencyName state county contacts.phone contacts.email contacts.chiefName contacts.chiefTitle callLog outreach')
    .lean()
  return agencies
    .map((agency) => {
      const call = latestCall(agency.callLog) || {}
      const calledAt = call.calledAt || call.loggedAt || agency.outreach?.lastCalledAt || null
      return {
        ori: agency.ori,
        name: agency.agencyName || '(unnamed agency)',
        state: agency.state || '',
        county: agency.county || '',
        outcome: call.outcome || agency.outreach?.lastOutcome || '',
        calledAt,
        followUpAt: call.followUpAt || null,
        dueAt: call.followUpAt || calledAt,
        loggedBy: call.loggedBy || agency.outreach?.lastLoggedBy || '',
        contactName: call.contactName || agency.contacts?.chiefName || '',
        contactTitle: call.contactName ? call.contactTitle || '' : agency.contacts?.chiefTitle || '',
        phone: call.phone || agency.contacts?.phone || '',
        email: agency.contacts?.email || '',
        notes: call.notes || '',
        callCount: agency.outreach?.callCount || (agency.callLog || []).length,
      }
    })
    .sort((a, b) => new Date(a.dueAt || 0) - new Date(b.dueAt || 0))
}

/** The email, as text. Pure, so the board can show it before anyone gets it. */
export function buildCallLaterEmail({ rows, total, to, from, timezone, names = {}, now = new Date() }) {
  const firstName = (to?.name || to?.email?.split('@')[0] || 'there').split(/\s+/)[0]
  const hub = (process.env.HUB_FRONTEND_URL?.trim() || 'https://trusted-fe-hub-agl8a.ondigitalocean.app').replace(/\/$/, '')
  const day = (value) =>
    value
      ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(
          new Date(value),
        )
      : ''
  const titleCase = (text) => String(text).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
  // Early calls were logged under the Auth0 subject rather than an email; an
  // id like google-oauth2|1035... names nobody, so it is left out.
  const who = (email) => {
    const value = String(email || '').toLowerCase()
    if (!value.includes('@')) return ''
    return (names[value] || value.split('@')[0]).split(/\s+/)[0]
  }
  const overdue = rows.filter((row) => row.followUpAt && new Date(row.followUpAt) < now).length

  const line = (row, index) => {
    const where = [row.county ? `${titleCase(row.county)} County` : '', row.state].filter(Boolean).join(', ')
    const last = [row.outcome, row.calledAt ? `on ${day(row.calledAt)}` : '', who(row.loggedBy) ? `by ${who(row.loggedBy)}` : '']
      .filter(Boolean)
      .join(' ')
    const due = row.followUpAt
      ? `${new Date(row.followUpAt) < now ? 'Was due' : 'Due'} ${day(row.followUpAt)}`
      : 'No call-back date set'
    const contact = row.contactName ? `${row.contactName}${row.contactTitle ? `, ${row.contactTitle}` : ''}` : ''
    const reach = [contact, row.phone].filter(Boolean).join(' · ') || 'no contact on file'
    const notes = row.notes ? `\n    "${row.notes.replace(/\s+/g, ' ').slice(0, 160)}${row.notes.length > 160 ? '...' : ''}"` : ''
    return `${index + 1}. ${row.name}${where ? ` (${where})` : ''}\n    ${due} · ${last}${row.callCount > 1 ? ` · ${row.callCount} calls` : ''}\n    ${reach}${notes}`
  }

  const text = [
    `Hi ${firstName},`,
    '',
    total > rows.length
      ? `There are ${total} agencies on the map waiting for a call back. Here are the ${rows.length} that have waited longest${overdue ? ` - ${overdue} of them are past the date promised` : ''}.`
      : `There are ${total} agencies on the map waiting for a call back${overdue ? `, ${overdue} of them past the date promised` : ''}. All of them are below, longest-waiting first.`,
    '',
    `They are the pink pins: open the map at ${hub}/agency-map`,
    '',
    ...rows.map(line).flatMap((entry) => [entry, '']),
    `Sent by Trusted Tech Central on behalf of ${from?.name || from?.email || 'the hub'}.`,
  ].join('\n')

  return {
    subject: `${rows.length} call-backs for the week${total > rows.length ? ` (of ${total} waiting)` : ''}`,
    text,
  }
}

/** Everything a send needs, and the email it would be. Used by the preview too. */
export async function prepareDigest(schedule) {
  const settings = digestSettings(schedule)
  const [all, from, members] = await Promise.all([
    callLaterAgencies(),
    schedule.notifyFrom ? HubMember.findOne({ email: schedule.notifyFrom }).lean() : null,
    HubMember.find({}).select('email name').lean(),
  ])
  const to = members.find((member) => member.email === settings.to)
  const names = Object.fromEntries(members.filter((m) => m.name).map((m) => [m.email, m.name]))
  const rows = all.slice(0, settings.limit)
  const email = buildCallLaterEmail({
    rows,
    total: all.length,
    to: to || { email: settings.to },
    from,
    timezone: schedule.timezone,
    names,
  })
  return { settings, from, rows, total: all.length, ...email }
}

/**
 * Send it now. `slot` is the lock - the local date for a scheduled send - and
 * a slot already taken returns null without sending anything.
 */
export async function sendDigest({ trigger = 'schedule', slot, sentBy = '' } = {}) {
  const schedule = await getSchedule()
  const claim = slot || `manual-${new Date().toISOString()}`
  let record
  try {
    record = await CallLaterDigestSend.create({ slot: claim, trigger, sentBy, host: os.hostname(), note: 'Sending...' })
  } catch (error) {
    if (error?.code === 11000) return null
    throw error
  }
  const finish = (fields) => CallLaterDigestSend.findByIdAndUpdate(record._id, { $set: fields }, { new: true }).lean()

  try {
    const { settings, from, rows, total, subject, text } = await prepareDigest(schedule)
    // The board entry is kept whether or not the email can go: Kyle's Friday
    // list must not depend on somebody's Gmail connection.
    await CallLaterDigestSend.updateOne(
      { _id: record._id },
      {
        $set: {
          to: settings.to,
          total,
          count: rows.length,
          rows: rows.map((row) => ({
            ori: row.ori,
            agency: row.name,
            county: row.county,
            state: row.state,
            contact: row.contactName,
            contactTitle: row.contactTitle,
            phone: row.phone,
            email: row.email,
            outcome: row.outcome,
            calledAt: row.calledAt,
            followUpAt: row.followUpAt,
            loggedBy: row.loggedBy,
            notes: row.notes,
            callCount: row.callCount,
          })),
        },
      },
    )
    if (!from?.gmail?.refreshToken) {
      return finish({ to: settings.to, total, note: `Not emailed: ${schedule.notifyFrom || 'no sender set'} has no Gmail connected.` })
    }
    if (!rows.length) return finish({ to: settings.to, total, note: 'Not emailed: no call-laters on the map.' })
    const cc = settings.cc.filter((address) => address && address !== settings.to)
    const id = await sendAsMember(from, { to: settings.to, cc, subject, text, fromName: from.name || '' })
    return finish({
      to: settings.to,
      count: rows.length,
      total,
      note: `Emailed from ${from.gmail.address}${cc.length ? `, cc ${cc.join(', ')}` : ''} (${id}).`,
    })
  } catch (error) {
    return finish({ note: `Failed: ${String(error?.message || error).slice(0, 300)}` })
  }
}

/** When the next Friday send is, for the board. */
export function nextDigestAt(schedule) {
  const settings = digestSettings(schedule)
  const { date, minutes, weekday } = localNow(schedule.timezone)
  const target = settings.hour * 60 + settings.minute
  let offset = (settings.weekday - weekday + 7) % 7
  if (offset === 0 && minutes >= target) offset = 7
  const [y, m, d] = date.split('-').map(Number)
  const guess = new Date(Date.UTC(y, m - 1, d + offset, settings.hour, settings.minute))
  let drift = localNow(schedule.timezone, guess).minutes - target
  if (drift > 720) drift -= 1440
  if (drift < -720) drift += 1440
  return new Date(guess.getTime() - drift * 60 * 1000)
}

/** One scheduler tick: send if it is the day, past the hour, and nobody has. */
export async function tickDigest() {
  const schedule = await getSchedule()
  const settings = digestSettings(schedule)
  if (!settings.enabled) return null
  const { date, minutes, weekday } = localNow(schedule.timezone)
  const target = settings.hour * 60 + settings.minute
  if (weekday !== settings.weekday || minutes < target || minutes > target + GRACE_MINUTES) return null
  if (await CallLaterDigestSend.exists({ slot: date })) return null
  return sendDigest({ trigger: 'schedule', slot: date })
}

export const recentDigests = (limit = 6) =>
  CallLaterDigestSend.find({}).select('-rows').sort({ createdAt: -1 }).limit(limit).lean()

/**
 * Whether `date` (the schedule's local YYYY-MM-DD) is this person's call-later
 * day, on which the morning does not research for them: the Friday list is
 * their work for the day instead.
 */
export function isCallLaterDayFor(schedule, email, date) {
  const settings = digestSettings(schedule)
  if (!settings.enabled || settings.to !== String(email || '').toLowerCase()) return false
  return new Date(`${date}T12:00:00Z`).getUTCDay() === settings.weekday
}

/**
 * The weekly lists a person was sent on schedule, newest first, for their
 * Your leads board. Button sends are tests and stay off it.
 */
export const callLaterListsFor = (email, limit = 8) =>
  CallLaterDigestSend.find({ to: String(email || '').toLowerCase(), trigger: 'schedule', 'rows.0': { $exists: true } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
