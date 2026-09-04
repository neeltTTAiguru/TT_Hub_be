import { Router } from 'express'
import LeAgency from '../models/LeAgency.js'
import { getAgencyBriefing } from '../services/agencyBriefing.js'
import { chatWithHermes } from '../services/hermesChat.js'
import TravellerState from '../models/TravellerState.js'
import { researchAndSaveBwc } from '../services/bwcResearch.js'
import { buildResearchRunWorkbook } from '../services/researchRunWorkbook.js'
import { activeRun, startRun, stopRun } from '../services/researchRunner.js'
import BwcResearchRun from '../models/BwcResearchRun.js'

const router = Router()

const MAX_LIMIT = 25000

/** A geocoded location beats the FBI pair, which is often a county centroid. */
const point = (agency) => ({
  lat: agency.location?.latitude ?? agency.latitude,
  lon: agency.location?.longitude ?? agency.longitude,
})

/**
 * The single definition of "the map can draw this agency".
 *
 * Shared by the geojson feed and the research-run preview on purpose: when the
 * two had their own tests they reported different totals for the same filters
 * (897 against 896), which reads as a bug in whichever number you trust less.
 * A latitude is not enough - the map plots from the GeoJSON point.
 */
const PLOTTABLE = { $or: [{ geo: { $exists: true } }, { 'location.geo': { $exists: true } }] }

const parseNumber = (value) => {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Shared filter builder so the list, geojson, and stats views stay consistent. */
const buildFilter = (query) => {
  const filter = {}

  const states = typeof query.state === 'string' ? query.state : query.states
  if (typeof states === 'string' && states.trim()) {
    const list = states.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (list.length) filter.state = list.length === 1 ? list[0] : { $in: list }
  }

  if (typeof query.agencyType === 'string' && query.agencyType.trim()) {
    const list = query.agencyType.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) filter.agencyType = list.length === 1 ? list[0] : { $in: list }
  }

  const minOfficers = parseNumber(query.minOfficers)
  const maxOfficers = parseNumber(query.maxOfficers)
  if (minOfficers !== null || maxOfficers !== null) {
    filter['employment.swornOfficers'] = { $ne: null }
    if (minOfficers !== null) filter['employment.swornOfficers'].$gte = minOfficers
    if (maxOfficers !== null) filter['employment.swornOfficers'].$lte = maxOfficers
  } else if (query.hasOfficerCount === 'true') {
    filter['employment.swornOfficers'] = { $ne: null }
  }

  // CRM overlay: 'matched' = in the HubSpot pipeline, 'unmatched' = never touched.
  if (query.crm === 'matched') filter['crm.matched'] = true
  if (query.crm === 'unmatched') filter['crm.matched'] = { $ne: true }
  if (typeof query.stage === 'string' && query.stage.trim()) {
    const list = query.stage.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) filter['crm.stage'] = list.length === 1 ? list[0] : { $in: list }
  }

  if (query.isNibrs === 'true') filter.isNibrs = true
  if (query.isNibrs === 'false') filter.isNibrs = false

  // Body-worn cameras, per the Atlas of Surveillance. 'none' means nobody has
  // documented one here, which is not the same as the agency having none.
  //
  // A hand-set verdict outranks the imported status, exactly as the map's own
  // colouring does. Without this the two disagree: an agency you marked as
  // having cameras still matched `bwc=unknown` here, so it drew red on the map
  // and a research run would have gone and researched it again anyway.
  const trustedUnset = {
    $or: [
      { 'surveillance.bwc.trustedResearched': { $exists: false } },
      { 'surveillance.bwc.trustedResearched': '' },
    ],
  }
  const verdict = (trusted, status) => ({
    $or: [
      { 'surveillance.bwc.trustedResearched': trusted },
      { $and: [trustedUnset, status] },
    ],
  })
  // $and rather than a bare $or, so a later `{ ...filter, $or: [...] }` spread
  // cannot silently overwrite the camera filter.
  if (query.bwc === 'true') {
    filter.$and = [verdict('has_bwc', { 'surveillance.bwc.status': 'yes' })]
  }
  if (query.bwc === 'false') {
    filter.$and = [verdict('no_bwc', { 'surveillance.bwc.status': 'no' })]
  }
  if (query.bwc === 'unknown') {
    filter.$and = [
      trustedUnset,
      {
        $or: [
          { 'surveillance.bwc.status': { $exists: false } },
          { 'surveillance.bwc.status': 'unknown' },
        ],
      },
    ]
  }
  if (typeof query.bwcEvidence === 'string' && query.bwcEvidence.trim()) {
    const list = query.bwcEvidence.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) {
      filter['surveillance.bwc.evidence'] = list.length === 1 ? list[0] : { $in: list }
    }
  }
  if (typeof query.bwcVendor === 'string' && query.bwcVendor.trim()) {
    const list = query.bwcVendor.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) {
      filter['surveillance.bwc.vendor'] = list.length === 1 ? list[0] : { $in: list }
    }
  }

  if (typeof query.search === 'string' && query.search.trim()) {
    // Escaped so a stray regex character in the search box cannot break the query.
    const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.agencyName = { $regex: escaped, $options: 'i' }
  }

  // Bounding box from a map viewport: minLon,minLat,maxLon,maxLat
  if (typeof query.bbox === 'string' && query.bbox.trim()) {
    const parts = query.bbox.split(',').map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [minLon, minLat, maxLon, maxLat] = parts
      filter.geo = {
        $geoWithin: {
          $box: [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
        },
      }
    }
  }

  // Radius search for territory planning: near=lat,lon&radiusMiles=50
  if (typeof query.near === 'string' && query.near.trim() && !filter.geo) {
    const [lat, lon] = query.near.split(',').map(Number)
    const radiusMiles = parseNumber(query.radiusMiles) ?? 50
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      filter.geo = {
        $geoWithin: { $centerSphere: [[lon, lat], radiusMiles / 3963.2] },
      }
    }
  }

  return filter
}

/**
 * A run as the map needs it.
 *
 * The trail is capped: a thousand-agency run polled every few seconds would
 * otherwise move the whole journey across the wire on every tick, and the map
 * only draws the recent part of the path anyway.
 */
const PATH_LIMIT = 400
const serializeRun = (run) => {
  const doc = run.toObject ? run.toObject() : run
  const path = doc.path || []
  return {
    id: String(doc._id),
    status: doc.status,
    brief: doc.brief || '',
    filtersLabel: doc.filtersLabel || '',
    total: doc.total,
    completed: doc.completed,
    failed: doc.failed,
    cursor: doc.cursor,
    searches: doc.searches,
    foundCameras: doc.foundCameras,
    foundEmails: doc.foundEmails,
    foundPhones: doc.foundPhones,
    current: doc.current || null,
    path: path.length > PATH_LIMIT ? path.slice(-PATH_LIMIT) : path,
    pathTruncated: path.length > PATH_LIMIT,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    lastError: doc.lastError || '',
  }
}

/** The run's targeting in words, so the spreadsheet can say what it covers. */
const describeFilters = (filters = {}) => {
  const parts = []
  parts.push(filters.state ? `States: ${filters.state}` : 'All states')
  if (filters.agencyType) parts.push(`Types: ${filters.agencyType}`)
  if (filters.minOfficers || filters.maxOfficers) {
    parts.push(`Officers: ${filters.minOfficers ?? 'any'} to ${filters.maxOfficers ?? 'any'}`)
  }
  if (filters.bwc === 'unknown') parts.push('Camera status unknown only')
  if (filters.bwc === 'true') parts.push('Known to have cameras')
  if (filters.bwc === 'false') parts.push('Known to have none')
  if (filters.search) parts.push(`Name contains "${filters.search}"`)
  return parts.join('; ')
}

router.get('/', async (req, res, next) => {
  try {
    const filter = buildFilter(req.query)
    const limit = Math.min(parseNumber(req.query.limit) ?? 100, MAX_LIMIT)
    const page = Math.max(parseNumber(req.query.page) ?? 1, 1)

    const [agencies, total] = await Promise.all([
      LeAgency.find(filter)
        .sort({ 'employment.swornOfficers': -1, agencyName: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      LeAgency.countDocuments(filter),
    ])

    res.json({ total, page, limit, agencies })
  } catch (error) {
    next(error)
  }
})

/** Map-ready payload. Feed straight into Leaflet, Mapbox, or deck.gl. */
router.get('/geojson', async (req, res, next) => {
  try {
    const base = buildFilter(req.query)
    // A bbox/near query already constrains geo; otherwise accept either point.
    // Around 2,700 agencies have no FBI coordinate at all and are on the map
    // only because enrichment resolved one, so requiring `geo` would drop them.
    // $and, not a spread: `bwc=unknown` also sets `$or`, and spreading a second
    // one overwrote it - silently dropping the camera filter from the map feed.
    const filter = base.geo ? base : { $and: [base, PLOTTABLE] }

    const limit = Math.min(parseNumber(req.query.limit) ?? MAX_LIMIT, MAX_LIMIT)

    const agencies = await LeAgency.find(filter)
      .select(
        'ori agencyName agencyType state county latitude longitude location ' +
          'fbiCoordIsCountyProxy employment contacts crm surveillance',
      )
      .limit(limit)
      .lean()

    // A geocoded address always beats the FBI pair, because just over half of
    // those are the county internal point rather than the agency's location.
    const pointFor = (agency) =>
      Number.isFinite(agency.location?.latitude) && Number.isFinite(agency.location?.longitude)
        ? {
            lat: agency.location.latitude,
            lon: agency.location.longitude,
            precision: agency.location.precision || 'street',
            source: agency.location.geocoder || 'census',
          }
        : {
            lat: agency.latitude,
            lon: agency.longitude,
            // An unresolved county proxy is an approximation and must say so.
            precision: agency.fbiCoordIsCountyProxy ? 'county' : 'fbi',
            source: 'fbi_cde',
          }

    res.json({
      type: 'FeatureCollection',
      features: agencies
        .map((agency) => ({ agency, point: pointFor(agency) }))
        .filter(({ point }) => Number.isFinite(point.lon) && Number.isFinite(point.lat))
        .map(({ agency, point }) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
          properties: {
            ori: agency.ori,
            name: agency.agencyName,
            precision: point.precision,
            locationSource: point.source,
            // Anything coarser than a street match should render as a guess.
            approximate: point.precision === 'county' || point.precision === 'city',
            streetAddress: agency.contacts?.streetAddress?.line1 || '',
            addressCity: agency.contacts?.streetAddress?.city || '',
            agencyType: agency.agencyType,
            state: agency.state,
            county: agency.county,
            swornOfficers: agency.employment?.swornOfficers ?? null,
            dataYear: agency.employment?.dataYear ?? null,
            website: agency.contacts?.website || '',
            phone: agency.contacts?.phone || '',
            email: agency.contacts?.email || '',
            chiefName: agency.contacts?.chiefName || '',
            chiefTitle: agency.contacts?.chiefTitle || '',
            chiefSourceUrl: agency.contacts?.chiefSourceUrl || '',
            commandStaff: (agency.contacts?.commandStaff || []).map((person) => ({
              name: person.name,
              title: person.title,
            })),
            // A documented body-worn camera. `bwcVendor` is blank far more
            // often than not, so the map must not read blank as "no vendor".
            hasBwc: Boolean(agency.surveillance?.bwc?.hasBwc),
            // status and evidence travel together on purpose: 'no' from a
            // survey and 'unknown' are completely different claims, and the
            // card rendered them identically while only hasBwc was sent.
            // Our own verdict, which the map colours by when it exists.
            bwcTrusted: agency.surveillance?.bwc?.trustedResearched || '',
            bwcTrustedBy: agency.surveillance?.bwc?.trustedResearchedBy || '',
            bwcStatus: agency.surveillance?.bwc?.status || 'unknown',
            bwcEvidence: agency.surveillance?.bwc?.evidence || '',
            bwcAsOf: agency.surveillance?.bwc?.asOf || null,
            bwcDeclineReasons: agency.surveillance?.bwc?.declineReasons || [],
            bwcVendor: agency.surveillance?.bwc?.vendor || '',
            // The evidence URL is deliberately NOT here. It is ~0.4MB across a
            // national pull and nothing on the map reads it; fetch the agency
            // itself when a citation is actually needed.
            bwcEvidenceDate: agency.surveillance?.bwc?.evidenceDate || null,
            inPipeline: Boolean(agency.crm?.matched),
            stage: agency.crm?.stage || '',
            stageRank: agency.crm?.stageRank ?? null,
            dealCount: agency.crm?.dealCount ?? 0,
            dealOwner: agency.crm?.owner || '',
          },
        })),
    })
  } catch (error) {
    next(error)
  }
})

/** Coverage and size-band rollups, for dashboard tiles and data-quality checks. */
router.get('/stats', async (req, res, next) => {
  try {
    const filter = buildFilter(req.query)

    const [totals, byState, byBand, byStage] = await Promise.all([
      LeAgency.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            agencies: { $sum: 1 },
            withCounts: {
              $sum: { $cond: [{ $ne: ['$employment.swornOfficers', null] }, 1, 0] },
            },
            // $ifNull first: an absent field is not null to $ne, so without it
            // every document that predates enrichment counts as resolved.
            withCoords: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $ne: ['$latitude', null] },
                      { $ne: [{ $ifNull: ['$location.latitude', null] }, null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            // How much of the map is STILL a county centre. The flag alone is a
            // historical record - most flagged agencies have since been given a
            // real coordinate - so it has to be paired with an unresolved
            // location or the figure reads an order of magnitude too high.
            countyProxies: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: [{ $ifNull: ['$fbiCoordIsCountyProxy', false] }, true] },
                      { $eq: [{ $ifNull: ['$location.resolvedAt', null] }, null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            resolved: {
              $sum: { $cond: [{ $ne: [{ $ifNull: ['$location.latitude', null] }, null] }, 1, 0] },
            },
            totalOfficers: { $sum: { $ifNull: ['$employment.swornOfficers', 0] } },
            inPipeline: { $sum: { $cond: ['$crm.matched', 1, 0] } },
            // Agencies with a documented body-worn camera, and the subset where
            // the vendor is actually named - the gap between the two is large.
            withBwc: {
              $sum: { $cond: [{ $eq: [{ $ifNull: ['$surveillance.bwc.hasBwc', false] }, true] }, 1, 0] },
            },
            withBwcVendor: {
              $sum: {
                $cond: [
                  { $not: [{ $in: [{ $ifNull: ['$surveillance.bwc.vendor', ''] }, ['', null]] }] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      LeAgency.aggregate([
        { $match: { ...filter, 'employment.swornOfficers': { $ne: null } } },
        {
          $group: {
            _id: '$state',
            agencies: { $sum: 1 },
            under100: { $sum: { $cond: [{ $lte: ['$employment.swornOfficers', 100] }, 1, 0] } },
          },
        },
        { $sort: { under100: -1 } },
      ]),
      LeAgency.aggregate([
        { $match: { ...filter, 'employment.swornOfficers': { $ne: null } } },
        {
          $bucket: {
            groupBy: '$employment.swornOfficers',
            boundaries: [0, 5, 10, 25, 50, 100, 250, 1000, 100000],
            default: 'unknown',
            output: { agencies: { $sum: 1 } },
          },
        },
      ]),
      LeAgency.aggregate([
        { $match: { ...filter, 'crm.matched': true } },
        { $group: { _id: '$crm.stage', agencies: { $sum: 1 }, rank: { $max: '$crm.stageRank' } } },
        { $sort: { rank: -1 } },
      ]),
    ])

    res.json({
      totals: totals[0] || { agencies: 0, withCounts: 0, withCoords: 0, totalOfficers: 0 },
      byState,
      bySizeBand: byBand,
      byStage,
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Where the research run is right now, and what it has finished.
 *
 * Deliberately tiny: the map already holds the national pull, so polling that
 * again to watch a job progress would move ten megabytes every few seconds.
 * This returns only what changed since the caller last asked.
 *
 * The traveller needs no state of its own. An agency is claimed as
 * 'processing' with a timestamp before any work starts, so the most recently
 * claimed one IS where the run currently stands.
 */
// Held for the life of the process so the idle traveller stays put between
// polls instead of teleporting every few seconds.
let idlePosition = null

router.get('/research-activity', async (req, res, next) => {
  try {
    const since = req.query.since ? new Date(String(req.query.since)) : null
    const now = new Date()

    const inFlight = await LeAgency.find({ 'enrichment.bwcResearchStatus': 'processing' })
      .select('ori agencyName state county latitude longitude location.latitude location.longitude enrichment.bwcResearchStartedAt')
      .sort({ 'enrichment.bwcResearchStartedAt': -1 })
      .limit(5)
      .lean()

    const travellers = inFlight
      .map((agency) => ({
        ori: agency.ori,
        name: agency.agencyName,
        state: agency.state,
        county: agency.county,
        startedAt: agency.enrichment?.bwcResearchStartedAt || null,
        ...point(agency),
      }))
      .filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lon))

    const done = since
      ? await LeAgency.find({ 'enrichment.bwcResearchedAt': { $gt: since } })
          .select('ori agencyName surveillance.bwc latitude longitude location.latitude location.longitude crm employment.swornOfficers')
          .limit(500)
          .lean()
      : []

    // Where the run last got to, so the traveller has a position even when
    // nothing is in flight. Without this he simply vanishes between runs, and
    // the most useful question - where did we get up to? - has no answer.
    const [last] = await LeAgency.find({ 'enrichment.bwcResearchedAt': { $ne: null } })
      .select('ori agencyName state county surveillance.bwc.status enrichment.bwcResearchedAt latitude longitude location.latitude location.longitude')
      .sort({ 'enrichment.bwcResearchedAt': -1 })
      .limit(1)
      .lean()
    const lastPoint = last ? point(last) : null
    const lastPosition =
      last && Number.isFinite(lastPoint.lat) && Number.isFinite(lastPoint.lon)
        ? {
            ori: last.ori,
            name: last.agencyName,
            state: last.state,
            county: last.county,
            status: last.surveillance?.bwc?.status || 'unknown',
            at: last.enrichment?.bwcResearchedAt || null,
            ...lastPoint,
          }
        : null

    // Before anything has been researched the traveller still needs somewhere
    // to stand, so he is dropped on a random mapped agency. Cached rather than
    // re-rolled per request: the map polls this every few seconds, and a fresh
    // random point each time would have him twitching across the country.
    let startPosition = null
    if (!lastPosition) {
      if (!idlePosition) {
        const [random] = await LeAgency.aggregate([
          {
            $match: {
              $or: [{ latitude: { $ne: null } }, { 'location.latitude': { $ne: null } }],
            },
          },
          { $sample: { size: 1 } },
          { $project: { ori: 1, agencyName: 1, state: 1, county: 1, latitude: 1, longitude: 1, location: 1 } },
        ])
        const randomPoint = random ? point(random) : null
        if (random && Number.isFinite(randomPoint.lat) && Number.isFinite(randomPoint.lon)) {
          idlePosition = {
            ori: random.ori,
            name: random.agencyName,
            state: random.state,
            county: random.county,
            status: 'unknown',
            at: null,
            ...randomPoint,
          }
        }
      }
      startPosition = idlePosition
    }

    // Somewhere he was sent by hand. It beats the last research only if it
    // happened more recently - if research has run since, he has evidently
    // moved on and the instruction is stale.
    const sent = await TravellerState.findOne({ key: 'singleton' }).lean()
    const sentAt = sent?.movedAt ? new Date(sent.movedAt).getTime() : 0
    const researchedAt = lastPosition?.at ? new Date(lastPosition.at).getTime() : 0
    const sentWins =
      sent && Number.isFinite(sent.lat) && Number.isFinite(sent.lon) && sentAt > researchedAt

    const resting = sentWins
      ? {
          ori: sent.ori,
          name: sent.name,
          state: sent.state,
          county: sent.county,
          status: 'unknown',
          at: sent.movedAt,
          lat: sent.lat,
          lon: sent.lon,
        }
      : lastPosition || startPosition

    res.json({
      now: now.toISOString(),
      travellers,
      lastPosition: resting,
      sentByHand: Boolean(sentWins),
      atStart: !lastPosition && !sentWins,
      completed: done.map((agency) => ({
        ori: agency.ori,
        name: agency.agencyName,
        ...point(agency),
        bwcStatus: agency.surveillance?.bwc?.status || 'unknown',
        bwcVendor: agency.surveillance?.bwc?.vendor || '',
        researchedAt: agency.enrichment?.bwcResearchedAt || null,
      })),
      remaining: await LeAgency.countDocuments({
        $and: [
          { $or: [{ 'surveillance.bwc.status': { $exists: false } }, { 'surveillance.bwc.status': 'unknown' }] },
          { $or: [{ 'enrichment.bwcResearchedAt': null }, { 'enrichment.bwcResearchedAt': { $exists: false } }] },
        ],
        ...(req.query.state ? { state: String(req.query.state).toUpperCase() } : {}),
      }),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Talk to the traveller.
 *
 * The nearest-agency question is answered from Mongo, not by the model. A
 * geo query returns the real answer in milliseconds and cannot invent a
 * department that does not exist; Hermes is here to phrase it and to field the
 * follow-ups, with the actual rows in front of it.
 */
/**
 * Research one agency, reporting each search as it happens.
 *
 * Server-sent events rather than a plain POST because the work takes the best
 * part of a minute and the interesting part is what it is doing during it. The
 * queries are the model's real ones, so the running commentary names the actual
 * council portals and check registers being dug through.
 */
/**
 * Put the traveller at a named agency.
 *
 * Writes the same singleton the chat does, so sending him from the map and
 * sending him by conversation cannot disagree about where he is.
 */
router.put('/traveller-position', async (req, res, next) => {
  try {
    const ori = String(req.body?.ori || '').toUpperCase()
    const agency = await LeAgency.findOne({ ori })
      .select('ori agencyName state county latitude longitude location.latitude location.longitude')
      .lean()
    if (!agency) return res.status(404).json({ message: 'Agency was not found.' })

    const at = point(agency)
    if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) {
      return res.status(400).json({ message: 'That agency has no location to stand on.' })
    }

    const position = {
      ori: agency.ori,
      name: agency.agencyName,
      state: agency.state,
      county: agency.county,
      ...at,
    }
    await TravellerState.updateOne(
      { key: 'singleton' },
      { $set: { ...position, movedAt: new Date() } },
      { upsert: true },
    )
    res.json(position)
  } catch (error) {
    next(error)
  }
})

/**
 * Scope and price a research run before anyone commits money to it.
 *
 * Deliberately reuses buildFilter, so a run targets exactly what the filter bar
 * above the map is already showing. The alternative - a second, separately
 * specified set of agencies - drifts away from what you are looking at without
 * ever telling you, and you find out after the bill.
 *
 * The numbers are measured, not guessed. A real run on Alpine PD cost $0.1022
 * at 6 searches, of which the searches were 59% - so search COUNT, not token
 * volume, is what moves the total. Adding a decision maker and a phone number
 * costs roughly three more searches per agency.
 *
 * Reads only. Nothing here starts a run.
 */
router.post('/research-run/preview', async (req, res, next) => {
  try {
    // Filters arrive in the body so the client can send exactly the object it
    // uses for the map, rather than re-encoding it as a query string.
    const filter = buildFilter({ ...(req.query || {}), ...(req.body?.filters || {}) })
    const skipResearched = req.body?.skipResearched !== false
    // Default to exactly what the map is drawing, so the two never disagree.
    // Agencies with no coordinate are still researchable - they have a website,
    // a sheriff and a phone - so this is a checkbox, not a permanent exclusion.
    const includeOffMap = req.body?.includeOffMap === true

    const doneClause = {
      $or: [
        { 'enrichment.bwcResearchedAt': { $ne: null } },
        { 'surveillance.bwc.trustedResearched': { $in: ['has_bwc', 'no_bwc'] } },
      ],
    }

    // Everything below is scoped by `scope`, so every number in the preview
    // describes the same set of agencies the run would actually visit.
    const scope = includeOffMap ? filter : { $and: [filter, PLOTTABLE] }

    const [matched, alreadyDone, offMap, needEmail, needPhone] = await Promise.all([
      LeAgency.countDocuments(scope),
      LeAgency.countDocuments({ $and: [scope, doneClause] }),
      LeAgency.countDocuments({ $and: [filter, { $nor: [PLOTTABLE] }] }),
      LeAgency.countDocuments({ $and: [scope, { 'contacts.email': { $in: [null, ''] } }] }),
      LeAgency.countDocuments({ $and: [scope, { 'contacts.phone': { $in: [null, ''] } }] }),
    ])

    const queue = skipResearched ? Math.max(matched - alreadyDone, 0) : matched

    // $10 per 1,000 web_search calls, plus measured input+output tokens.
    const SEARCH = 0.01
    const TOKENS = 0.042
    const low = 9 * SEARCH + TOKENS
    // 16, not 13. A measured end-to-end run on Encinal PD spent 14 searches
    // (13 on cameras, 1 on the chief), which was above the old ceiling - a
    // small agency with nothing published is the expensive case, not the cheap
    // one, because the model keeps looking.
    const high = 16 * SEARCH + TOKENS
    const SECONDS_EACH = 60 // measured end-to-end on a real agency: ~55s

    res.json({
      matched,
      alreadyDone,
      queue,
      offMap,
      includeOffMap,
      needEmail,
      needPhone,
      perAgency: { low: Number(low.toFixed(3)), high: Number(high.toFixed(3)) },
      cost: { low: Number((queue * low).toFixed(2)), high: Number((queue * high).toFixed(2)) },
      hours: {
        serial: Number(((queue * SECONDS_EACH) / 3600).toFixed(1)),
        concurrent3: Number(((queue * SECONDS_EACH) / 3 / 3600).toFixed(1)),
      },
      searchesPerAgency: { low: 9, high: 16 },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Resolve the targeting to a concrete list of ORIs.
 *
 * Shared by start and export so a run visits exactly the agencies the preview
 * counted, in the same order, with the same exclusions.
 */
const resolveRunScope = async (body = {}, query = {}) => {
  const filter = buildFilter({ ...query, ...(body.filters || {}) })
  const skipResearched = body.skipResearched !== false
  const includeOffMap = body.includeOffMap === true

  const clauses = [filter]
  if (!includeOffMap) clauses.push(PLOTTABLE)
  if (skipResearched) {
    clauses.push({
      'enrichment.bwcResearchedAt': null,
      'surveillance.bwc.trustedResearched': { $nin: ['has_bwc', 'no_bwc'] },
    })
  }
  return { where: { $and: clauses }, skipResearched, includeOffMap }
}

/**
 * The run's output as a spreadsheet.
 *
 * Takes the same body as the preview, so what you download is exactly the set
 * the preview priced - no second filter to keep in step. Rows exist for every
 * targeted agency whether or not the run has reached them yet: a blank camera
 * cell is the run's to-do list, and hiding those rows would make a half-finished
 * run look complete.
 */
router.post('/research-run/export', async (req, res, next) => {
  try {
    const { where, skipResearched, includeOffMap } = await resolveRunScope(req.body, req.query)

    const agencies = await LeAgency.find(where)
      .select(
        'ori agencyName agencyType state county latitude longitude geo location ' +
          'employment contacts crm surveillance enrichment',
      )
      .sort({ state: 1, agencyName: 1 })
      .limit(MAX_LIMIT)
      .lean()

    const workbook = await buildResearchRunWorkbook(agencies, {
      Targeting: describeFilters(req.body?.filters || {}),
      Brief: String(req.body?.brief || '').slice(0, 2000),
      'Already-researched agencies': skipResearched ? 'Skipped' : 'Included',
      'Agencies with no coordinate': includeOffMap ? 'Included' : 'Excluded',
    })

    const stamp = new Date().toISOString().slice(0, 10)
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="research-run-${stamp}.xlsx"`,
      'Content-Length': String(workbook.length),
      'Cache-Control': 'private, no-store',
    })
    res.send(workbook)
  } catch (error) {
    next(error)
  }
})

/** Start a run. It keeps going after you close the tab - that is the point. */
router.post('/research-run/start', async (req, res, next) => {
  try {
    const { where, skipResearched, includeOffMap } = await resolveRunScope(req.body, req.query)
    const oris = (await LeAgency.find(where).select('ori').limit(MAX_LIMIT).lean()).map((a) => a.ori)

    // A limit is how you test: same targeting, same prompt, same cost per
    // agency, one agency of it. Anything else tests a different thing than the
    // run you are about to pay for.
    const limit = parseNumber(req.body?.limit)

    const run = await startRun({
      oris,
      brief: String(req.body?.brief || '').slice(0, 2000),
      filters: req.body?.filters || {},
      filtersLabel: describeFilters(req.body?.filters || {}),
      skipResearched,
      includeOffMap,
      limit,
      startedBy: req.auth?.payload?.sub || '',
    })
    res.status(201).json(serializeRun(run))
  } catch (error) {
    next(error)
  }
})

/**
 * What the run is doing right now, for anyone who has the hub open.
 *
 * Global, not per user: everybody watching sees the same traveller in the same
 * place, because there is one run and the server owns it.
 */
router.get('/research-run/active', async (req, res, next) => {
  try {
    const run =
      (await activeRun()) ||
      (await BwcResearchRun.findOne({ status: { $in: ['done', 'stopped', 'failed'] } }).sort({
        createdAt: -1,
      }))
    res.json(run ? serializeRun(run) : { run: null })
  } catch (error) {
    next(error)
  }
})

/**
 * A finished run's spreadsheet, exported by run id rather than by filters.
 *
 * The run stores the exact ORIs it queued, so this returns precisely the
 * agencies that run covered - no re-deriving from filters, which would drift
 * as later research changes what matches them.
 *
 * "Skip already researched" is deliberately NOT applied. It scopes a run before
 * it starts; applying it afterwards would exclude every agency the run just
 * finished and hand back an empty sheet.
 */
router.post('/research-run/:id/export', async (req, res, next) => {
  try {
    const run = await BwcResearchRun.findById(req.params.id).lean()
    if (!run) return res.status(404).json({ message: 'That run no longer exists.' })

    const agencies = await LeAgency.find({ ori: { $in: run.queue } })
      .select(
        'ori agencyName agencyType state county employment contacts crm surveillance enrichment',
      )
      .sort({ state: 1, agencyName: 1 })
      .lean()

    const workbook = await buildResearchRunWorkbook(agencies, {
      Targeting: run.filtersLabel || '',
      Brief: run.brief || '',
      Status: run.status,
      Researched: `${run.completed} of ${run.total}`,
      Failed: String(run.failed || 0),
      Started: run.startedAt ? new Date(run.startedAt).toISOString() : '',
      Finished: run.finishedAt ? new Date(run.finishedAt).toISOString() : '',
    })

    const stamp = new Date(run.startedAt || Date.now()).toISOString().slice(0, 10)
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="research-run-${stamp}.xlsx"`,
      'Content-Length': String(workbook.length),
      'Cache-Control': 'private, no-store',
    })
    return res.send(workbook)
  } catch (error) {
    return next(error)
  }
})

/** Ask the run to stop. It finishes the agency in flight, then stops. */
router.post('/research-run/stop', async (req, res, next) => {
  try {
    const run = await stopRun()
    if (!run) return res.status(404).json({ message: 'No run is going.' })
    return res.json(serializeRun(run))
  } catch (error) {
    return next(error)
  }
})

router.get('/:ori/research-stream', async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    // Some proxies buffer an idle stream shut; a comment every 15s keeps it open.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

    try {
      const result = await researchAndSaveBwc(req.params.ori, (query) => send('search', { query }))
      send('done', result)
    } catch (error) {
      send('failed', { message: String(error.message).slice(0, 300) })
    } finally {
      clearInterval(heartbeat)
      res.end()
    }
  } catch (error) {
    next(error)
  }
})

router.post('/traveller-chat', async (req, res, next) => {
  try {
    const { messages = [], lat, lon, ori } = req.body || {}
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
      return res.status(400).json({ message: 'lat and lon are required.' })
    }
    const here = [Number(lon), Number(lat)]

    const nearby = await LeAgency.find({
      $or: [
        { geo: { $near: { $geometry: { type: 'Point', coordinates: here }, $maxDistance: 400000 } } },
      ],
    })
      .select(
        'ori agencyName state county agencyType employment.swornOfficers surveillance.bwc ' +
          'contacts.chiefName contacts.chiefTitle contacts.phone contacts.email contacts.website ' +
          'contacts.streetAddress crm.matched crm.stage latitude longitude location.latitude location.longitude',
      )
      .limit(12)
      .lean()

    const miles = (agency) => {
      const aLat = agency.location?.latitude ?? agency.latitude
      const aLon = agency.location?.longitude ?? agency.longitude
      if (!Number.isFinite(aLat) || !Number.isFinite(aLon)) return null
      const toRad = (d) => (d * Math.PI) / 180
      const dLat = toRad(aLat - Number(lat))
      const dLon = toRad(aLon - Number(lon))
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(Number(lat))) * Math.cos(toRad(aLat)) * Math.sin(dLon / 2) ** 2
      return Math.round(2 * 3958.7613 * Math.asin(Math.sqrt(h)))
    }

    // Everything the agency card shows, so he is never the last to know. He was
    // saying he had no website for an agency whose website was on screen beside
    // him, and had no idea what a research run had just turned up.
    const listing = nearby
      .map((agency, i) => {
        const bwc = agency.surveillance?.bwc || {}
        const c = agency.contacts || {}
        return [
          `${i + 1}. ${agency.agencyName} (${agency.county || '?'} County, ${agency.state}), ` +
            `${miles(agency) ?? '?'} miles, ORI ${agency.ori}`,
          `   sworn: ${agency.employment?.swornOfficers ?? 'unknown'}`,
          `   cameras: ${bwc.status || 'unknown'}${bwc.vendor ? ` (${bwc.vendor})` : ''}` +
            `${bwc.evidence ? `, established by ${bwc.evidence}` : ''}` +
            `${bwc.asOf ? ` as of ${new Date(bwc.asOf).getFullYear()}` : ''}` +
            `${bwc.contractEnd ? `, contract ends ${new Date(bwc.contractEnd).toISOString().slice(0, 10)}` : ''}`,
          bwc.evidenceUrl ? `   camera source: ${bwc.evidenceUrl}` : '',
          bwc.summary ? `   what the source said: ${String(bwc.summary).slice(0, 240)}` : '',
          c.chiefName ? `   chief: ${[c.chiefTitle, c.chiefName].filter(Boolean).join(' ')}` : '',
          c.phone ? `   phone: ${c.phone}` : '',
          c.email ? `   email: ${c.email}` : '',
          c.website ? `   website: ${c.website}` : '   website: not on file',
          c.streetAddress?.line1
            ? `   address: ${[c.streetAddress.line1, c.streetAddress.city].filter(Boolean).join(', ')}`
            : '',
          agency.crm?.matched ? `   in HubSpot: ${agency.crm.stage || 'yes'}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      })
      .join('\n\n')

    const standingAt = ori
      ? await LeAgency.findOne({ ori: String(ori).toUpperCase() }).select('ori agencyName').lean()
      : null

    const instructions = [
      'You are the traveller on a law enforcement agency map: a weathered surveyor who',
      'walks the country cataloguing which police agencies run body-worn cameras.',
      'Speak plainly and briefly, first person, a little wry. Never gushing.',
      '',
      'The agencies below are the real ones nearest you, already sorted by distance and',
      'taken straight from the database. Answer from THIS LIST only. Never invent an',
      'agency, a distance, a vendor or a contact. If the list does not cover the',
      'question, say so.',
      '',
      '"cameras: unknown" means nobody has published either way - it does NOT mean',
      'the agency has none. Say it that way.',
      '',
      'Each entry carries the website, phone, email, chief, and - where research has',
      'run - the source it was established from and what that source said. Use them.',
      'Only say something is not on file when the entry actually says so.',
      '',
      'Keep answers to a few sentences unless asked for more.',
      '',
      'YOU CAN WALK. If asked to go somewhere - a city, county, state or a named',
      'agency - set moveTo to that place as written, and say you are setting off.',
      'Do not refuse on the grounds that it is not in your list; the list is only',
      'what is near you now, not where you are allowed to go.',
      '',
      'YOU CAN SEARCH THE WHOLE COUNTRY, not just what is around you. If asked for',
      'a kind of agency rather than a named one - "somewhere on the Texas border",',
      '"the smallest department in Nevada", "who has no cameras near El Paso" - set',
      'find with what you are after. Never answer "not in my list" to a question',
      'like that; the list is only your immediate surroundings, not the database.',
      'find.near is a town you choose yourself when the request is geographic: for',
      'the Texas border pick a real border town - El Paso, Presidio, Del Rio,',
      'Eagle Pass, Laredo, McAllen, Brownsville.',
      '',
      'YOU MAY CHOOSE WHERE TO GO. If a request implies travel but names no place,',
      'pick a sensible one yourself and set moveTo rather than offering to.',
      '',
      'ACT, DO NOT NARRATE. If you name a town in your reply you MUST also put it in',
      'find.near or moveTo.place. Saying "I would start near El Paso" while leaving',
      'both empty is a failure - you have told the user something will happen and',
      'then not done it. Same for "I could set off": either set moveTo, or do not',
      'say it.',
      '',
      'YOU CAN ALSO GO AND FIND OUT. If asked to research, look into, check or dig',
      'up whether an agency runs cameras, set researchOri to that agency\'s ORI from',
      'the list. It takes you a minute and it updates the map. Do NOT say cameras',
      'are unknown and stop there when you were asked to find out - go and look.',
      '',
      'Reply with ONE JSON object and nothing else:',
      '{"reply":"what you say, a few sentences","moveTo":{"place":"","state":""},',
      ' "researchOri":"","find":{"state":"","near":"","maxOfficers":null,"minOfficers":null,',
      ' "cameras":"","withinMiles":null,"beyondMiles":null}}',
      'find.cameras is yes, no or unknown.',
      'find.withinMiles and find.beyondMiles are distances from find.near, or from',
      'where you stand if you set no near. "out past 80 miles" is beyondMiles 80;',
      '"within an hour of here" is withinMiles 50. Use them whenever the request is',
      'about how far out something is, rather than guessing which towns qualify.',
      'Leave find out entirely unless you were asked to look something up beyond',
      'your surroundings.',
      '',
      'WORKED EXAMPLE, because this is the step most often got wrong.',
      'User: "find me a police department close to the Texas border"',
      'RIGHT: {"reply":"El Paso way, then.","find":{"state":"TX","near":"El Paso"}}',
      'WRONG: {"reply":"I would start near El Paso.","find":{}}',
      'WRONG: {"reply":"I am looking near El Paso, give me a minute."}',
      'The two wrong ones promise something and do nothing. You have no minute to',
      'take - the search happens the moment you set find, and nothing happens at',
      'all if you leave it empty.',
      'moveTo.place is JUST the town or county, cleanly spelled, no state in it.',
      'moveTo.state is the two-letter code. Correct obvious typos: "fortworth" is',
      'Fort Worth, TX. Leave both empty unless you were actually asked to travel.',
      '',
      // Naming it matters: given only coordinates he had to guess which entry
      // was underfoot, and answered about the agency next door instead.
      standingAt
        ? `YOU ARE STANDING AT: ${standingAt.agencyName} (ORI ${standingAt.ori}). When the user says` +
          ' "they" or "their" with no other agency named, they mean this one.'
        : `WHERE YOU ARE STANDING: ${Number(lat).toFixed(3)}, ${Number(lon).toFixed(3)}`,
      '',
      'NEAREST AGENCIES:',
      listing || '(nothing within 250 miles)',
    ].join('\n')

    const reply = await chatWithHermes(
      process.env.TRAVELLER_AGENT_ID || 'trusted-tech-assistant',
      messages.slice(-10).map(({ role, content }) => ({ role, content: String(content).slice(0, 2000) })),
      { instructions, memoryContext: '', timeoutMs: 90000, rateLimitRetries: 1 },
    )

    // The model replies as JSON so it can ask to move; fall back to treating
    // the whole thing as prose if it did not comply.
    const raw = String(reply?.message?.content || '')
    let parsed = null
    try {
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start !== -1 && end > start) parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
      parsed = null
    }
    const said = String(parsed?.reply || raw).trim()
    const researchOri = String(parsed?.researchOri || '').trim().toUpperCase()

    // A search across the whole database rather than his immediate
    // surroundings. Run here, in Mongo, for the same reason the nearby list is:
    // he can phrase an answer, he cannot be trusted to remember which Texas
    // towns sit on the border or how many officers a department has.
    const find = parsed?.find || null
    let found = []
    if (find && (find.state || find.near || find.maxOfficers || find.minOfficers || find.cameras)) {
      const filter = {}
      if (find.state) filter.state = String(find.state).trim().toUpperCase()
      if (find.cameras === 'unknown') {
        filter.$or = [
          { 'surveillance.bwc.status': { $exists: false } },
          { 'surveillance.bwc.status': 'unknown' },
        ]
      } else if (['yes', 'no'].includes(find.cameras)) {
        filter['surveillance.bwc.status'] = find.cameras
      }
      // Number(null) is 0 and Number.isFinite(0) is true, so reading these
      // straight through turned "no size preference" into "exactly zero sworn
      // officers" - which matched nothing real, and occasionally matched an
      // agency with a genuine 0 in the field.
      const asCount = (value) =>
        value === null || value === undefined || value === '' ? null : Number(value)
      const min = asCount(find.minOfficers)
      const max = asCount(find.maxOfficers)
      if (Number.isFinite(min) || Number.isFinite(max)) {
        filter['employment.swornOfficers'] = { $ne: null }
        if (Number.isFinite(min)) filter['employment.swornOfficers'].$gte = min
        if (Number.isFinite(max)) filter['employment.swornOfficers'].$lte = max
      }

      const within = asCount(find.withinMiles)
      const beyond = asCount(find.beyondMiles)

      // A town he named: anchor the search there rather than on where he stands.
      let anchor = null
      if (String(find.near || '').trim()) {
        const rx = new RegExp(String(find.near).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        anchor = await LeAgency.findOne({
          $or: [{ 'contacts.streetAddress.city': rx }, { county: rx }, { agencyName: rx }],
          ...(filter.state ? { state: filter.state } : {}),
          $and: [{ $or: [{ latitude: { $ne: null } }, { 'location.latitude': { $ne: null } }] }],
        })
          .select('latitude longitude location.latitude location.longitude')
          .sort({ 'employment.swornOfficers': -1 })
          .lean()
      }
      // Falls back to where he is standing, so "anything out past 80 miles"
      // means 80 miles from him rather than from nowhere in particular.
      const anchorPoint = anchor
        ? point(anchor)
        : Number.isFinite(within) || Number.isFinite(beyond)
          ? { lat: Number(lat), lon: Number(lon) }
          : null

      const MILE_IN_METRES = 1609.34
      const near = anchorPoint
        ? {
            $near: {
              $geometry: { type: 'Point', coordinates: [anchorPoint.lon, anchorPoint.lat] },
              ...(Number.isFinite(within) ? { $maxDistance: within * MILE_IN_METRES } : {}),
              ...(Number.isFinite(beyond) ? { $minDistance: beyond * MILE_IN_METRES } : {}),
            },
          }
        : null

      const query = near ? { ...filter, geo: near } : filter

      found = await LeAgency.find(query)
        .select('ori agencyName state county employment.swornOfficers surveillance.bwc.status surveillance.bwc.vendor')
        .limit(8)
        .lean()
    }
    const place = String(parsed?.moveTo?.place || '').trim()
    const destState = String(parsed?.moveTo?.state || '').trim().toUpperCase()

    let moved = null
    if (place) {
      const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const rx = new RegExp(escaped, 'i')
      const mapped = { $or: [{ latitude: { $ne: null } }, { 'location.latitude': { $ne: null } }] }
      // City first: "Fort Worth" is a city, and the crosswalk gives us those.
      // Then county, then the agency's own name. Biggest agency in the place
      // wins, since that is the one someone means by "go to Fort Worth".
      const attempts = [
        { 'contacts.streetAddress.city': rx },
        { county: rx },
        { agencyName: rx },
      ]
      let destination = null
      for (const attempt of attempts) {
        destination = await LeAgency.findOne({
          ...attempt,
          ...(destState ? { state: destState } : {}),
          ...mapped,
        })
          .select('ori agencyName state county latitude longitude location.latitude location.longitude')
          .sort({ 'employment.swornOfficers': -1 })
          .lean()
        if (destination) break
      }
      const destPoint = destination ? point(destination) : null
      if (destination && Number.isFinite(destPoint.lat) && Number.isFinite(destPoint.lon)) {
        moved = {
          ori: destination.ori,
          name: destination.agencyName,
          state: destination.state,
          county: destination.county,
          ...destPoint,
        }
        await TravellerState.updateOne(
          { key: 'singleton' },
          { $set: { ...moved, movedAt: new Date() } },
          { upsert: true },
        )
      }
    }

    // He must not say he is setting off if the place could not be found. A
    // cheerful "on my way" while standing still is the worst possible answer.
    const finalReply =
      place && !moved
        ? `I could not find ${place}${destState ? `, ${destState}` : ''} on my map - no agency there I can place. Try a town or county name.`
        : said

    // He was asked to go and find out, so he does - then reports what he found
    // rather than what he already had.
    let researched = null
    if (researchOri && !place) {
      try {
        researched = await researchAndSaveBwc(researchOri)
      } catch (error) {
        researched = { ori: researchOri, error: String(error.message).slice(0, 200) }
      }
    }

    // A second pass, because the first reply was composed BEFORE the search ran
    // and so could not refer to it. Bolting the rows onto the end produced
    // answers that contradicted themselves: he named an agency from his
    // immediate surroundings while the list underneath showed a different one.
    let searchReply = ''
    if (found.length) {
      const rows = found
        .map(
          (agency) =>
            `- ${agency.agencyName} (${agency.county || '?'} County, ${agency.state}), ` +
            `${agency.employment?.swornOfficers ?? 'unknown'} sworn, cameras ${
              agency.surveillance?.bwc?.status || 'unknown'
            }${agency.surveillance?.bwc?.vendor ? ` (${agency.surveillance.bwc.vendor})` : ''}, ORI ${agency.ori}`,
        )
        .join('\n')
      const second = await chatWithHermes(
        process.env.TRAVELLER_AGENT_ID || 'trusted-tech-assistant',
        [
          {
            role: 'user',
            content: `You searched and these came back. Answer the question from THESE rows only, in two or three sentences, plain first person. Do not mention agencies that are not listed.\n\nQuestion: ${
              messages[messages.length - 1]?.content || ''
            }\n\nResults:\n${rows}`,
          },
        ],
        {
          instructions:
            'You are the traveller: a weathered surveyor cataloguing which police agencies run body-worn cameras. Plain, brief, first person, a little wry. Do NOT call any tool. "cameras unknown" means nobody has published either way, not that they have none.',
          memoryContext: '',
          timeoutMs: 60000,
          rateLimitRetries: 1,
        },
      )
      searchReply = String(second?.message?.content || '').trim()
    }

    const spoken = researched
      ? researched.error
        ? `I went looking into ${researched.ori} and could not get anywhere: ${researched.error}`
        : researched.status === 'unknown'
          ? `I had a proper look at ${researched.name} - ${researched.searches} searches - and nobody has published either way. A records request would settle it.`
          : `${researched.name}: ${researched.status.replace(/_/g, ' ')}${
              researched.vendor ? `, ${researched.vendor}` : ''
            }${researched.contractEnd ? `, contract to ${researched.contractEnd}` : ''}. ` +
            `${researched.quote ? `"${researched.quote}" ` : ''}Source: ${researched.sourceUrl}`
      : searchReply || finalReply

    res.json({
      reply: spoken,
      found: found.map((agency) => ({
        ori: agency.ori,
        name: agency.agencyName,
        state: agency.state,
        county: agency.county,
        officers: agency.employment?.swornOfficers ?? null,
        bwcStatus: agency.surveillance?.bwc?.status || 'unknown',
      })),
      researched,
      moved,
      nearest: nearby.slice(0, 5).map((agency) => ({
        ori: agency.ori,
        name: agency.agencyName,
        miles: miles(agency),
        bwcStatus: agency.surveillance?.bwc?.status || 'unknown',
      })),
    })
  } catch (error) {
    next(error)
  }
})

/**
 * Set the trusted verdict by hand.
 *
 * Research returns "unknown" often - small agencies publish nothing, and no
 * amount of searching invents a source. When someone knows the answer anyway
 * (they rang them, they have been there), they need to be able to say so
 * without that being indistinguishable from a researched finding. Hence
 * trustedResearchedBy: a citation and a person's word are both useful, and
 * they are not the same thing.
 */
router.patch('/:ori/trusted-bwc', async (req, res, next) => {
  try {
    const value = String(req.body?.value ?? '').trim()
    if (!['has_bwc', 'no_bwc', ''].includes(value)) {
      return res.status(400).json({ message: "value must be 'has_bwc', 'no_bwc' or empty." })
    }
    const ori = String(req.params.ori).toUpperCase()

    const vendor = String(req.body?.vendor || '').trim().slice(0, 120)
    const set = value
      ? {
          'surveillance.bwc.trustedResearched': value,
          'surveillance.bwc.trustedResearchedAt': new Date(),
          'surveillance.bwc.trustedResearchedBy': 'manual',
          'surveillance.bwc.trustedResearchedNote': String(req.body?.note || '').slice(0, 300),
          // Only alongside has_bwc, and only when actually given - an empty box
          // must not wipe a vendor that research already established.
          ...(value === 'has_bwc' && vendor ? { 'surveillance.bwc.vendor': vendor } : {}),
        }
      : {
          'surveillance.bwc.trustedResearched': '',
          'surveillance.bwc.trustedResearchedAt': null,
          'surveillance.bwc.trustedResearchedBy': '',
          'surveillance.bwc.trustedResearchedNote': '',
        }

    const result = await LeAgency.updateOne({ ori }, { $set: set })
    if (!result.matchedCount) return res.status(404).json({ message: 'Agency was not found.' })

    const agency = await LeAgency.findOne({ ori }).select('ori agencyName surveillance.bwc').lean()
    res.json({
      ori: agency.ori,
      name: agency.agencyName,
      trustedResearched: agency.surveillance?.bwc?.trustedResearched || '',
      trustedResearchedBy: agency.surveillance?.bwc?.trustedResearchedBy || '',
      trustedResearchedAt: agency.surveillance?.bwc?.trustedResearchedAt || null,
      vendor: agency.surveillance?.bwc?.vendor || '',
    })
  } catch (error) {
    next(error)
  }
})

router.get('/:ori/briefing', async (req, res, next) => {
  try {
    const briefing = await getAgencyBriefing(req.params.ori, {
      refresh: req.query.refresh === 'true',
    })
    res.json(briefing)
  } catch (error) {
    next(error)
  }
})

router.get('/:ori', async (req, res, next) => {
  try {
    const agency = await LeAgency.findOne({ ori: req.params.ori.toUpperCase() }).lean()
    if (!agency) return res.status(404).json({ message: 'Agency was not found.' })
    res.json(agency)
  } catch (error) {
    next(error)
  }
})

export default router
