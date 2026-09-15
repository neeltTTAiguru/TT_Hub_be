import LeAgency from '../models/LeAgency.js'
import BwcResearchRun from '../models/BwcResearchRun.js'
import TravellerState from '../models/TravellerState.js'
import { resolveActor } from '../middleware/auth.js'

/** The last N lines of a conversation are kept; older ones fall off the end. */
export const CHAT_LIMIT = 40

// Anyone who has not opened the map in this long stops being drawn for the
// others. Their traveller is not deleted - he is waiting where they left him -
// he just is not cluttering the map for people who are actually here.
const PRESENCE_DAYS = 14

// lastSeenAt is written at most this often per person. The map polls activity
// every few seconds and a write per poll would be most of the collection's
// traffic for nothing.
const SEEN_THROTTLE_MS = 60 * 1000

const point = (agency) => ({
  lat: agency.location?.latitude ?? agency.latitude,
  lon: agency.location?.longitude ?? agency.longitude,
})

const placed = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)

/**
 * A name to write on the label above his head.
 *
 * The token's name claim when there is one; otherwise the part of the email
 * before the @, split on dots and capitalised - "neel.palle" reads as
 * "Neel Palle" rather than an address. An opaque subject gets "Someone",
 * which is honest.
 */
export function displayNameFor(payload, email) {
  const claimed = typeof payload?.name === 'string' ? payload.name.trim() : ''
  if (claimed && !claimed.includes('@')) return claimed
  const local = String(email || '').split('@')[0]
  if (!local) return 'Someone'
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * The caller's traveller, created on first sight.
 *
 * Drops a new one on a random mapped agency so he is standing somewhere from
 * the first poll. Random rather than a fixed spot: everybody starting on the
 * same pin would stack five travellers on top of each other.
 */
export async function travellerFor(req) {
  const key = await resolveActor(req)
  if (!key) {
    const error = new Error('Your account could not be identified.')
    error.statusCode = 401
    throw error
  }
  const payload = req.auth?.payload
  const email = key.includes('@') ? key : ''

  let doc = await TravellerState.findOne({ key })
  if (!doc) {
    const start = await randomStart()
    doc = await TravellerState.findOneAndUpdate(
      { key },
      {
        $setOnInsert: {
          key,
          email,
          displayName: displayNameFor(payload, email),
          ...(start || {}),
          movedAt: null,
          chat: [],
          lastSeenAt: new Date(),
        },
      },
      { upsert: true, new: true },
    )
  } else if (!doc.lastSeenAt || Date.now() - doc.lastSeenAt.getTime() > SEEN_THROTTLE_MS) {
    await TravellerState.updateOne({ key }, { $set: { lastSeenAt: new Date() } })
  }
  return doc
}

async function randomStart() {
  const [random] = await LeAgency.aggregate([
    { $match: { $or: [{ latitude: { $ne: null } }, { 'location.latitude': { $ne: null } }] } },
    { $sample: { size: 1 } },
    { $project: { ori: 1, agencyName: 1, state: 1, county: 1, latitude: 1, longitude: 1, location: 1 } },
  ])
  if (!random) return null
  const at = point(random)
  if (!placed(at)) return null
  return { ori: random.ori, name: random.agencyName, state: random.state, county: random.county, ...at }
}

/**
 * Where each traveller is standing right now.
 *
 * A person who has a research run going is the walker: their traveller is at
 * the run's current stop, labelled as working. When their run has finished
 * they stay at its last stop, unless they have since sent him somewhere else
 * by hand - the more recent instruction wins. Everyone else is simply where
 * they left him.
 *
 * Runs are looked up per person rather than once, but there are a handful of
 * people and the query is indexed on startedBy; it is not worth a join.
 */
export async function positionsFor(req) {
  const me = await travellerFor(req)
  const since = new Date(Date.now() - PRESENCE_DAYS * 24 * 60 * 60 * 1000)
  const others = await TravellerState.find({
    key: { $ne: me.key, $nin: ['singleton'] },
    lastSeenAt: { $gte: since },
  })
    .select('key email displayName ori name state county lat lon movedAt lastSeenAt')
    .lean()

  const live = await BwcResearchRun.findOne({ status: { $in: ['running', 'stopping'] } })
    .select('startedBy current path')
    .sort({ createdAt: -1 })
    .lean()

  const resolve = async (doc, mine) => {
    const ownsRun = Boolean(live && live.startedBy && live.startedBy === doc.key)
    let at = null
    let working = false

    if (ownsRun) {
      const stop = live.current || (live.path?.length ? live.path[live.path.length - 1] : null)
      if (placed(stop)) {
        at = { ori: stop.ori, name: stop.name, state: stop.state, county: '', lat: stop.lat, lon: stop.lon }
        working = true
      }
    }

    if (!at) {
      // The last run this person walked, in case it got somewhere more recently
      // than they last sent him by hand.
      const last = await BwcResearchRun.findOne({
        startedBy: doc.key,
        status: { $in: ['done', 'stopped', 'failed'] },
      })
        .select('path finishedAt')
        .sort({ createdAt: -1 })
        .lean()
      const stop = last?.path?.length ? last.path[last.path.length - 1] : null
      const stopAt = stop?.at ? new Date(stop.at).getTime() : 0
      const movedAt = doc.movedAt ? new Date(doc.movedAt).getTime() : 0
      if (placed(stop) && stopAt > movedAt) {
        at = { ori: stop.ori, name: stop.name, state: stop.state, county: '', lat: stop.lat, lon: stop.lon }
      }
    }

    if (!at && placed(doc)) {
      at = { ori: doc.ori, name: doc.name, state: doc.state, county: doc.county, lat: doc.lat, lon: doc.lon }
    }

    return {
      key: doc.key,
      displayName: doc.displayName || displayNameFor(null, doc.email),
      mine,
      ownsRun,
      working,
      at,
      lastSeenAt: doc.lastSeenAt || null,
    }
  }

  const resolved = await Promise.all([resolve(me, true), ...others.map((doc) => resolve(doc, false))])
  const [self, ...rest] = resolved
  return { me: self, others: rest.filter((t) => t.at) }
}

/**
 * Send the caller's traveller to a named agency.
 *
 * The same write whether he is sent from the map, from a briefing, or by
 * asking him in chat, so the three cannot disagree about where he is.
 */
export async function moveTraveller(req, ori) {
  const agency = await LeAgency.findOne({ ori: String(ori || '').toUpperCase() })
    .select('ori agencyName state county latitude longitude location.latitude location.longitude')
    .lean()
  if (!agency) {
    const error = new Error('Agency was not found.')
    error.statusCode = 404
    throw error
  }
  const at = point(agency)
  if (!placed(at)) {
    const error = new Error('That agency has no location to stand on.')
    error.statusCode = 400
    throw error
  }
  const position = { ori: agency.ori, name: agency.agencyName, state: agency.state, county: agency.county, ...at }
  return placeTraveller(req, position)
}

/** Stand the caller's traveller on an already-resolved position. */
export async function placeTraveller(req, position) {
  const me = await travellerFor(req)
  await TravellerState.updateOne({ key: me.key }, { $set: { ...position, movedAt: new Date() } })
  return position
}

/**
 * Remember the last exchange.
 *
 * Only the newest user line and the reply are appended - the client sends the
 * whole thread with every message, and storing it whole each time would
 * duplicate every earlier line on every turn.
 */
export async function rememberChat(req, userLine, reply) {
  const me = await travellerFor(req)
  const lines = []
  if (userLine) lines.push({ role: 'user', content: String(userLine).slice(0, 4000), at: new Date() })
  if (reply) lines.push({ role: 'assistant', content: String(reply).slice(0, 8000), at: new Date() })
  if (!lines.length) return
  await TravellerState.updateOne(
    { key: me.key },
    { $push: { chat: { $each: lines, $slice: -CHAT_LIMIT } } },
  )
}
