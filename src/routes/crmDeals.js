import { Router } from 'express'
import CrmDeal from '../models/CrmDeal.js'

const router = Router()

const buildFilter = (query) => {
  const filter = {}

  if (typeof query.stage === 'string' && query.stage.trim()) {
    const list = query.stage.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) filter.stage = list.length === 1 ? list[0] : { $in: list }
  }
  if (typeof query.state === 'string' && query.state.trim()) {
    filter.state = query.state.trim().toUpperCase()
  }
  if (query.lawEnforcement === 'true') filter.isLawEnforcement = true
  if (query.lawEnforcement === 'false') filter.isLawEnforcement = false
  // Let callers exclude the coarse state-centroid pins when precision matters.
  if (query.exactOnly === 'true') filter.locationSource = 'exact'

  return filter
}

router.get('/', async (req, res, next) => {
  try {
    const deals = await CrmDeal.find(buildFilter(req.query))
      .sort({ stageRank: -1, dealName: 1 })
      .limit(2000)
      .lean()
    res.json({ total: deals.length, deals })
  } catch (error) {
    next(error)
  }
})

router.get('/geojson', async (req, res, next) => {
  try {
    const deals = await CrmDeal.find({ ...buildFilter(req.query), geo: { $exists: true } })
      .limit(5000)
      .lean()

    res.json({
      type: 'FeatureCollection',
      features: deals
        .filter((d) => Number.isFinite(d.longitude) && Number.isFinite(d.latitude))
        .map((deal) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [deal.longitude, deal.latitude] },
          properties: {
            dealId: deal.dealId,
            name: deal.dealName,
            stage: deal.stage,
            owner: deal.owner,
            state: deal.state,
            ori: deal.ori,
            matchedAgencyName: deal.matchedAgencyName,
            isLawEnforcement: deal.isLawEnforcement,
            locationSource: deal.locationSource,
            locationNote: deal.locationNote,
          },
        })),
    })
  } catch (error) {
    next(error)
  }
})

/** Deals that could not be placed, so they are visible rather than silently gone. */
router.get('/unplaced', async (req, res, next) => {
  try {
    const deals = await CrmDeal.find({ ...buildFilter(req.query), latitude: null })
      .select('dealId dealName stage owner state locationNote')
      .sort({ stageRank: -1, dealName: 1 })
      .lean()
    res.json({ total: deals.length, deals })
  } catch (error) {
    next(error)
  }
})

/**
 * Deal counts by stage, for the map's stage filter.
 *
 * The le-agencies stats route also reports a byStage rollup, but it counts
 * *agencies* carrying a deal, and only a third of our deals sit on an
 * FBI-rostered agency - probation departments, recovery firms and municipal
 * contracts appear in no federal roster. Counting agencies therefore read
 * "Closed Won (2)" against 12 real won deals. This counts the deals.
 *
 * `unplaced` is reported alongside because a deal with no usable location
 * never reaches the map, and the gap should be visible rather than puzzling.
 */
router.get('/stats', async (req, res, next) => {
  try {
    const byStage = await CrmDeal.aggregate([
      { $match: buildFilter(req.query) },
      {
        $group: {
          _id: '$stage',
          deals: { $sum: 1 },
          placed: { $sum: { $cond: [{ $ne: ['$latitude', null] }, 1, 0] } },
          rank: { $max: '$stageRank' },
        },
      },
      { $sort: { rank: -1 } },
    ])

    res.json({
      total: byStage.reduce((sum, row) => sum + row.deals, 0),
      byStage: byStage.map((row) => ({ ...row, unplaced: row.deals - row.placed })),
    })
  } catch (error) {
    next(error)
  }
})

export default router
