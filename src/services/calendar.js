/**
 * Each person's own Google Calendar, on the same grant as their Gmail.
 *
 * There is one Google connection per member and it is made on the Gmail
 * page; this service only spends it. Everything OAuth - the encrypted refresh
 * token, refreshing it, noticing a revoked grant - stays in services/gmail.js
 * and arrives here as `googleAccessToken`.
 *
 * One calendar, `primary`. The scope the hub asks for (calendar.events) can
 * read and write events but cannot list which calendars exist, which is the
 * honest trade: a person's own calendar, no ability to reshare or delete one.
 *
 * Requires the Google Calendar API to be enabled on the same Cloud project as
 * the OAuth client. Nothing else to configure.
 */
import HubMember from '../models/HubMember.js'
import { googleAccessToken, hasCalendarScope } from './gmail.js'

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary'

/**
 * Whose diary the map's call-backs go in, whoever logged the call.
 *
 * Outbound is one person's job here: anybody may leave a voicemail on their
 * territory, but the ring-back is worked by the person who owns outbound, so
 * it has to land in their week and not in the diary of whoever happened to
 * dial. A setting rather than a name in the source, because that ownership
 * moves and a rename must not need a deploy.
 *
 * CALL_BACK_CALENDAR_EMAIL - the hub member whose calendar receives them.
 */
export const callBackOwnerEmail = () =>
  (process.env.CALL_BACK_CALENDAR_EMAIL?.trim() || 'kyle@trustedtechnology.ai').toLowerCase()

/**
 * That person, and whether their calendar can actually be written to.
 *
 * The call log asks before it offers the tick box: a call-back owner who has
 * not connected Google is a tick box that would silently do nothing, and the
 * SAE leaving the voicemail has no way to guess that from their own screen.
 */
export async function callBackOwner() {
  const email = callBackOwnerEmail()
  const member = await HubMember.findOne({ email }).lean()
  return {
    email,
    name: member?.name || email.split('@')[0],
    ready: Boolean(member?.gmail?.refreshToken) && hasCalendarScope(member),
    member,
  }
}

const notConnected = () =>
  Object.assign(new Error('Connect your Google account on the Gmail page first.'), { statusCode: 409 })

/**
 * A grant from before Calendar existed refreshes fine and then fails on every
 * calendar call with a bare 403. Catching it here means the page can say
 * "reconnect" rather than "Request had insufficient authentication scopes".
 */
const needsReconnect = () =>
  Object.assign(
    new Error('Your Google connection was made before Calendar was added. Reconnect it to grant calendar access.'),
    { statusCode: 409, code: 'calendar_scope_missing' },
  )

const calendarFetch = async (member, path, init = {}) => {
  if (!member?.gmail?.refreshToken) throw notConnected()
  if (!hasCalendarScope(member)) throw needsReconnect()
  const accessToken = await googleAccessToken(member)
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  if (response.status === 204) return {}
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 403 && /insufficient|scope/i.test(data.error?.message || '')) throw needsReconnect()
    throw Object.assign(new Error(data.error?.message || `Calendar error ${response.status}.`), { statusCode: 502 })
  }
  return data
}

/**
 * Google returns a timed event as `dateTime` and an all-day one as `date`.
 * Flattening that here keeps the difference in one place: the rest of the hub
 * gets a start, an end and an `allDay` flag.
 */
const shape = (event) => ({
  id: event.id,
  summary: event.summary || '',
  description: event.description || '',
  location: event.location || '',
  allDay: Boolean(event.start?.date),
  start: event.start?.dateTime || event.start?.date || '',
  end: event.end?.dateTime || event.end?.date || '',
  status: event.status || 'confirmed',
  htmlLink: event.htmlLink || '',
  organizer: event.organizer?.email || '',
  hangoutLink: event.hangoutLink || '',
  attendees: (event.attendees || []).map((a) => ({
    email: a.email || '',
    name: a.displayName || '',
    response: a.responseStatus || 'needsAction',
    organizer: Boolean(a.organizer),
  })),
  // Whether this person may edit it. A calendar someone else owns and shared
  // read-only is still in the feed; the page must not offer to edit it.
  canEdit: event.guestsCanModify === true || !event.organizer || event.organizer?.self === true,
})

/**
 * Every event between two instants, recurrences expanded.
 *
 * `singleEvents` turns a weekly stand-up into the individual mornings it
 * actually occupies, which is the only form a month grid can draw.
 */
export async function listEvents(member, { timeMin, timeMax } = {}) {
  const items = []
  let timeZone = ''
  let pageToken = ''
  // Google caps a page at 250. A month of a calendar with several daily
  // recurrences passes that, and a half-drawn month is worse than a slow one,
  // so follow the tokens - bounded, because this is a month and not an
  // archive.
  for (let page = 0; page < 6; page += 1) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const data = await calendarFetch(member, `/events?${params.toString()}`)
    timeZone = timeZone || data.timeZone || ''
    items.push(...(data.items || []))
    pageToken = data.nextPageToken || ''
    if (!pageToken) break
  }
  return {
    timeZone,
    events: items.filter((event) => event.status !== 'cancelled').map(shape),
  }
}

export const getEvent = async (member, id) => shape(await calendarFetch(member, `/events/${encodeURIComponent(id)}`))

/**
 * Build the Google event body from what the form collects.
 *
 * An all-day event's `end.date` is exclusive - a one-day event ends the next
 * morning - so the day the person picked is shifted by one on the way out and
 * back again on the way in. Getting this wrong is how an all-day event
 * silently loses its last day.
 */
const eventBody = ({ summary, description = '', location = '', allDay = false, start, end, attendees = [], timeZone = '' }) => {
  const nextDay = (date) => {
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  const when = allDay
    ? { start: { date: String(start).slice(0, 10) }, end: { date: nextDay(String(end || start).slice(0, 10)) } }
    : {
        start: { dateTime: new Date(start).toISOString(), ...(timeZone ? { timeZone } : {}) },
        end: { dateTime: new Date(end).toISOString(), ...(timeZone ? { timeZone } : {}) },
      }
  return {
    summary: String(summary || '').slice(0, 300),
    description: String(description || '').slice(0, 8000),
    location: String(location || '').slice(0, 300),
    ...when,
    ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
  }
}

/**
 * `sendUpdates=all` because an event with guests and no invitation is a
 * meeting nobody knows about. Without guests Google ignores it.
 */
export async function createEvent(member, input) {
  const data = await calendarFetch(member, '/events?sendUpdates=all', {
    method: 'POST',
    body: JSON.stringify(eventBody(input)),
  })
  return shape(data)
}

export async function updateEvent(member, id, input) {
  const data = await calendarFetch(member, `/events/${encodeURIComponent(id)}?sendUpdates=all`, {
    method: 'PATCH',
    body: JSON.stringify(eventBody(input)),
  })
  return shape(data)
}

/** Cancels it and tells the guests. Google keeps the tombstone; the feed drops it. */
export async function deleteEvent(member, id) {
  await calendarFetch(member, `/events/${encodeURIComponent(id)}?sendUpdates=all`, { method: 'DELETE' })
  return { ok: true }
}

/**
 * The call-back an SAE promised, on their own calendar.
 *
 * Booked from the map's call log rather than by hand, because a voicemail
 * with a follow-up date and nothing in the diary is a call-back that does not
 * happen. Half an hour, which is a slot rather than a claim about the call's
 * length; the agency's number is the location so it can be dialled from the
 * reminder.
 *
 * Goes in the call-back owner's diary rather than the caller's - see
 * `callBackOwnerEmail` - so the description names who actually rang.
 *
 * Best effort by contract: the caller has already saved the call, and an
 * owner who has not connected Google, or connected before Calendar existed,
 * must not have somebody else's call log refused over a diary entry. Every
 * failure comes back as a reason, never as a throw.
 */
export async function bookCallBack(
  member,
  { agencyName, at, phone = '', contactName = '', notes = '', loggedBy = '', existingEventId = '' },
) {
  const start = new Date(at)
  if (Number.isNaN(start.getTime())) return { error: 'The follow-up time was not a date.' }
  const end = new Date(start.getTime() + 30 * 60 * 1000)
  const input = {
    summary: `Call back: ${agencyName}`,
    description: [
      contactName ? `Contact: ${contactName}` : '',
      phone ? `Phone: ${phone}` : '',
      // Whoever rang is very often not whoever is reading this event.
      loggedBy ? `Voicemail left by: ${loggedBy}` : '',
      notes ? `\nFrom the last call:\n${notes}` : '',
      '\nBooked from the Agency Map call log.',
    ]
      .filter(Boolean)
      .join('\n'),
    location: phone,
    allDay: false,
    start: start.toISOString(),
    end: end.toISOString(),
  }
  try {
    const event = existingEventId
      ? await updateEvent(member, existingEventId, input)
      : await createEvent(member, input)
    return { id: event.id, at: event.start }
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 300) }
  }
}
