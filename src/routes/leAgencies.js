import { Router } from 'express'
import LeAgency from '../models/LeAgency.js'
import { getAgencyBriefing } from '../services/agencyBriefing.js'

const router = Router()

const MAX_LIMIT = 25000

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
  if (query.bwc === 'true') filter['surveillance.bwc.status'] = 'yes'
  if (query.bwc === 'false') filter['surveillance.bwc.status'] = 'no'
  if (query.bwc === 'unknown') {
    filter.$or = [
      { 'surveillance.bwc.status': { $exists: false } },
      { 'surveillance.bwc.status': 'unknown' },
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
    const filter = base.geo
      ? base
      : { ...base, $or: [{ geo: { $exists: true } }, { 'location.geo': { $exists: true } }] }

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
