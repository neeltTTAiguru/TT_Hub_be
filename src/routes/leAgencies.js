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
    // A bbox/near query already constrains geo; otherwise just require coordinates.
    const filter = base.geo ? base : { ...base, geo: { $exists: true } }

    const limit = Math.min(parseNumber(req.query.limit) ?? MAX_LIMIT, MAX_LIMIT)

    const agencies = await LeAgency.find(filter)
      .select('ori agencyName agencyType state county latitude longitude employment contacts crm')
      .limit(limit)
      .lean()

    res.json({
      type: 'FeatureCollection',
      features: agencies
        .filter((a) => Number.isFinite(a.longitude) && Number.isFinite(a.latitude))
        .map((agency) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [agency.longitude, agency.latitude] },
          properties: {
            ori: agency.ori,
            name: agency.agencyName,
            agencyType: agency.agencyType,
            state: agency.state,
            county: agency.county,
            swornOfficers: agency.employment?.swornOfficers ?? null,
            dataYear: agency.employment?.dataYear ?? null,
            website: agency.contacts?.website || '',
            phone: agency.contacts?.phone || '',
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
            withCoords: { $sum: { $cond: [{ $ne: ['$latitude', null] }, 1, 0] } },
            totalOfficers: { $sum: { $ifNull: ['$employment.swornOfficers', 0] } },
            inPipeline: { $sum: { $cond: ['$crm.matched', 1, 0] } },
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
