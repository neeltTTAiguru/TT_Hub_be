import { Router } from 'express'
import HubMember from '../models/HubMember.js'
import { resolveActorEmail } from '../middleware/featureAccess.js'
import { connectUrl, statusFor } from '../services/gmail.js'
import { callBackOwner, createEvent, deleteEvent, getEvent, listEvents, listOverlays, updateEvent } from '../services/calendar.js'

/**
 * The signed-in person's own Google Calendar.
 *
 * Same shape as /gmail and the same member lookup, because it is the same
 * connection: /calendar/connect is a convenience that hands back the Gmail
 * consent URL tagged to return to the calendar page, so somebody who lands on
 * Calendar first never has to go and find the Gmail page to connect.
 */
const router = Router()

const memberFor = async (req) => {
  const email = await resolveActorEmail(req)
  if (!email) throw Object.assign(new Error('Your account has no email, so Calendar cannot be connected to it.'), { statusCode: 403 })
  return { email, member: await HubMember.findOne({ email }).lean() }
}

const looksLikeEmail = (value) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)

/**
 * This person's own connection, plus whose diary the map's voicemail
 * call-backs land in. The call log needs the second to label its tick box
 * honestly - it is usually not the person reading it.
 */
router.get('/status', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    const { email, name, ready } = await callBackOwner()
    res.json({ ...statusFor(member), callBack: { email, name, ready } })
  } catch (error) {
    next(error)
  }
})

router.get('/connect', async (req, res, next) => {
  try {
    const { email } = await memberFor(req)
    res.json({ url: connectUrl(email, 'calendar') })
  } catch (error) {
    next(error)
  }
})

/**
 * The events in a window. The page asks for the month it is drawing, padded
 * to the weeks either side of it, so the leading and trailing days of the
 * grid are filled in too.
 */
router.get('/events', async (req, res, next) => {
  try {
    const { email, member } = await memberFor(req)
    const timeMin = new Date(String(req.query.timeMin || ''))
    const timeMax = new Date(String(req.query.timeMax || ''))
    if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime())) {
      return res.status(400).json({ message: 'A start and an end are needed.' })
    }
    const window = { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() }
    // Colleagues' calendars ride along with the viewer's own - see
    // CALENDAR_OVERLAYS. Fetched side by side so they cost no extra wait.
    const [own, overlays] = await Promise.all([listEvents(member, window), listOverlays(email, window)])
    return res.json({ ...own, overlays })
  } catch (error) {
    return next(error)
  }
})

router.get('/events/:id', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    res.json(await getEvent(member, String(req.params.id)))
  } catch (error) {
    next(error)
  }
})

/** What both the create and the edit body must contain, or the reason it must not go. */
const readEvent = (body) => {
  const summary = String(body?.summary || '').trim()
  if (!summary) return { error: 'Give the event a title.' }
  const allDay = Boolean(body?.allDay)
  const start = String(body?.start || '').trim()
  const end = String(body?.end || start).trim()
  if (!start || !end) return { error: 'A start and an end are needed.' }
  if (allDay ? end.slice(0, 10) < start.slice(0, 10) : new Date(end) <= new Date(start)) {
    return { error: 'The event ends before it starts.' }
  }
  const attendees = (Array.isArray(body?.attendees) ? body.attendees : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  const bad = attendees.find((email) => !looksLikeEmail(email))
  if (bad) return { error: `"${bad}" does not look like an email address.` }
  return {
    input: {
      summary,
      description: String(body?.description || ''),
      location: String(body?.location || ''),
      allDay,
      start,
      end,
      attendees,
      timeZone: String(body?.timeZone || '').slice(0, 64),
      // Absent means "leave the call as it is", which is not the same as false.
      meet: typeof body?.meet === 'boolean' ? body.meet : undefined,
    },
  }
}

router.post('/events', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    const { input, error } = readEvent(req.body)
    if (error) return res.status(400).json({ message: error })
    return res.json(await createEvent(member, input))
  } catch (error) {
    return next(error)
  }
})

router.patch('/events/:id', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    const { input, error } = readEvent(req.body)
    if (error) return res.status(400).json({ message: error })
    return res.json(await updateEvent(member, String(req.params.id), input))
  } catch (error) {
    return next(error)
  }
})

router.delete('/events/:id', async (req, res, next) => {
  try {
    const { member } = await memberFor(req)
    res.json(await deleteEvent(member, String(req.params.id)))
  } catch (error) {
    next(error)
  }
})

export default router
