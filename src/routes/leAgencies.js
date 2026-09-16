import { Router } from 'express'
import LeAgency from '../models/LeAgency.js'
import { getAgencyBriefing } from '../services/agencyBriefing.js'
import { buildCallReportStats, generateCallReportNarrative } from '../services/callReport.js'
import { createCallReportPdfBuffer } from '../services/callReportPdf.js'
import { chatWithHermes } from '../services/hermesChat.js'
import { moveTraveller, placeTraveller, positionsFor, rememberChat, travellerFor } from '../services/travellers.js'
import { researchAndSaveBwc } from '../services/bwcResearch.js'
import {
  buildResearchRunWorkbook,
  buildRunFindingsWorkbook,
  runFindingsRows,
} from '../services/researchRunWorkbook.js'
import { activeRun, startRun, stopRun } from '../services/researchRunner.js'
import { syncAgencyToHubSpot } from '../services/hubspotSync.js'
import { requireLoggedByEmail, syncMapCallToHubSpot } from '../services/hubspotMapCalls.js'
import BwcResearchRun from '../models/BwcResearchRun.js'
import { resolveActor } from '../middleware/auth.js'
import { requireFullAccess } from '../middleware/featureAccess.js'
import { buildFilter, describeFilters, parseNumber } from '../services/leAgencyFilters.js'

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
          'fbiCoordIsCountyProxy employment contacts crm surveillance isTestRecord outreach',
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
            // Sent so the map can colour it distinctly. A test agency that
            // looks like a real pin is a trap someone eventually calls.
            isTest: Boolean(agency.isTestRecord),
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
            // Has anyone rung them. The summary is sent, never the log itself:
            // the notes of every call across a national pull would be
            // megabytes on the wire to answer a yes/no the map colours by.
            contacted: Boolean(agency.outreach?.callCount),
            callCount: agency.outreach?.callCount ?? 0,
            lastCalledAt: agency.outreach?.lastCalledAt || null,
            lastCallOutcome: agency.outreach?.lastOutcome || '',
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
    // A test record joining the headline counts is worse than no test record.
    const filter = { ...buildFilter(req.query), isTestRecord: { $ne: true } }

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
 * The in-flight list needs no state of its own. An agency is claimed as
 * 'processing' with a timestamp before any work starts, so the most recently
 * claimed one IS where the run currently stands. Where each person's traveller
 * is standing comes from positionsFor, which knows whose run that is.
 */
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

    // Everyone's traveller, the caller's first. Created on first sight, so
    // opening the map is what puts you on it.
    const { me, others } = await positionsFor(req)

    res.json({
      now: now.toISOString(),
      travellers,
      me,
      others,
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
 * Put the caller's traveller at a named agency.
 *
 * Writes the same document the chat does, so sending him from the map and
 * sending him by conversation cannot disagree about where he is.
 */
router.put('/traveller-position', async (req, res, next) => {
  try {
    res.json(await moveTraveller(req, req.body?.ori))
  } catch (error) {
    next(error)
  }
})

/**
 * The caller's own traveller: where he is and what was last said.
 *
 * Lets the chat panel pick the conversation back up after a reload rather
 * than opening on an empty thread every time.
 */
router.get('/traveller', async (req, res, next) => {
  try {
    const doc = await travellerFor(req)
    const { me } = await positionsFor(req)
    res.json({
      ...me,
      chat: (doc.chat || []).map((line) => ({ role: line.role, content: line.content, at: line.at })),
    })
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
router.post('/research-run/preview', requireFullAccess, async (req, res, next) => {
  try {
    // Filters arrive in the body so the client can send exactly the object it
    // uses for the map, rather than re-encoding it as a query string.
    // Same exclusion as resolveRunScope: the preview has to price the run that
    // will actually happen, and a fake agency in the count is a fake agency in
    // the bill.
    const filter = {
      ...buildFilter({ ...(req.query || {}), ...(req.body?.filters || {}) }),
      isTestRecord: { $ne: true },
    }
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

    const eligible = skipResearched ? Math.max(matched - alreadyDone, 0) : matched

    // A cap is the same knob start honours: "25 of these", not "all of these".
    // Priced here so the confirmation shows the bill for the run that will
    // actually happen, not for the whole pool it is drawn from.
    const limit = parseNumber(req.body?.limit)
    const queue = Number.isFinite(limit) && limit > 0 ? Math.min(eligible, limit) : eligible

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
      eligible,
      queue,
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
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
 * A filename that says what the file is without being opened.
 *
 * These land in a downloads folder among a hundred other things and get mailed
 * around, so "research-run.xlsx" is useless a week later. Scope and date first,
 * because that is what someone is looking for when they go back for one.
 */
const workbookFilename = (filters = {}, count = 0, when = new Date()) => {
  const states = String(filters.state || '')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean)
  const scope = states.length ? states.slice(0, 4).join('-') : 'all-states'
  const date = new Date(when).toISOString().slice(0, 10)
  const size = `${count}-${count === 1 ? 'agency' : 'agencies'}`
  // Belt and braces: a stray character here becomes a broken Content-Disposition.
  const safe = `trustedtech_map_research_${scope}_${date}_${size}`.replace(/[^A-Za-z0-9._-]/g, '')
  return `${safe}.xlsx`
}

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

  // Never research a fake agency, and never bill for it.
  const clauses = [filter, { isTestRecord: { $ne: true } }]
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
router.post('/research-run/export', requireFullAccess, async (req, res, next) => {
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

    const filename = workbookFilename(req.body?.filters, agencies.length)
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(workbook.length),
      'Cache-Control': 'private, no-store',
    })
    res.send(workbook)
  } catch (error) {
    next(error)
  }
})

/** Start a run. It keeps going after you close the tab - that is the point. */
router.post('/research-run/start', requireFullAccess, async (req, res, next) => {
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
      startedBy: await resolveActor(req),
    })
    res.status(201).json(serializeRun(run))
  } catch (error) {
    next(error)
  }
})

/**
 * Every run there has been, newest first, for the menu on the map.
 *
 * Summaries only - no path, no queue. A run with two thousand stops is a
 * megabyte, and the menu wants a line each; the findings endpoint carries the
 * rows for whichever run someone opens.
 */
router.get('/research-run', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseNumber(req.query.limit) || 50, 1), 200)
    const runs = await BwcResearchRun.find({})
      .select('-path -queue -current -leaseId -leaseExpiresAt')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
    res.json(
      runs.map((run) => ({
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
      })),
    )
  } catch (error) {
    next(error)
  }
})

/**
 * What the run is doing right now, for anyone who has the hub open.
 *
 * Global, not per user: everybody watching sees the same walker in the same
 * place, because there is one run and the server owns it. The walker is the
 * traveller of whoever started the run; everyone else's stays put.
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
 * A run's findings on screen, for anyone who can see the map.
 *
 * The rows are the spreadsheet's rows - same builder, same shape - so a person
 * who is not allowed the download still reads exactly what the download would
 * say. The full path is returned here, not the PATH_LIMIT tail that
 * /research-run/active sends for drawing the trail: a table with the last 400
 * of 2,000 rows is not the run's results.
 */
router.get('/research-run/:id/findings', async (req, res, next) => {
  try {
    const run = await BwcResearchRun.findById(req.params.id).lean()
    if (!run) return res.status(404).json({ message: 'That run no longer exists.' })

    return res.json({
      id: String(run._id),
      status: run.status,
      brief: run.brief || '',
      filtersLabel: run.filtersLabel || '',
      total: run.total,
      completed: run.completed,
      failed: run.failed,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      rows: runFindingsRows(run),
    })
  } catch (error) {
    return next(error)
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
router.post('/research-run/:id/export', requireFullAccess, async (req, res, next) => {
  try {
    const run = await BwcResearchRun.findById(req.params.id).lean()
    if (!run) return res.status(404).json({ message: 'That run no longer exists.' })

    const workbook = await buildRunFindingsWorkbook(run, {
      Targeting: run.filtersLabel || '',
      Brief: run.brief || '',
      Status: run.status,
      Researched: `${run.completed} of ${run.total}`,
      Failed: String(run.failed || 0),
      Started: run.startedAt ? new Date(run.startedAt).toISOString() : '',
      Finished: run.finishedAt ? new Date(run.finishedAt).toISOString() : '',
    })

    const filename = workbookFilename(run.filters, (run.path || []).length, run.startedAt)
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(workbook.length),
      'Cache-Control': 'private, no-store',
    })
    return res.send(workbook)
  } catch (error) {
    return next(error)
  }
})

/** Ask the run to stop. It finishes the agency in flight, then stops. */
router.post('/research-run/stop', requireFullAccess, async (req, res, next) => {
  try {
    const run = await stopRun()
    if (!run) return res.status(404).json({ message: 'No run is going.' })
    return res.json(serializeRun(run))
  } catch (error) {
    return next(error)
  }
})

// Behind the same gate as a run: one agency is one agency's worth of searches,
// but it is still money, and the button that reaches it is hidden for the same
// accounts the run form is.
router.get('/:ori/research-stream', requireFullAccess, async (req, res, next) => {
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
        await placeTraveller(req, moved)
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

    // Remembered per person, so a reload does not lose what he just said.
    await rememberChat(req, messages[messages.length - 1]?.content, spoken)

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

/**
 * Save the TMAN-P qualification for an agency.
 *
 * Shared like everything else on this map - one record per agency, not per
 * user. Two people working the same territory should see the same answers,
 * and a second SDR ringing an agency needs to know the first one already did.
 */
router.patch('/:ori/sdr', async (req, res, next) => {
  try {
    const body = req.body || {}
    const text = (value) => String(value ?? '').slice(0, 2000).trim()
    const fields = {
      timeline: text(body.timeline),
      money: text(body.money),
      authority: text(body.authority),
      needs: text(body.needs),
      pain: text(body.pain),
      notes: text(body.notes),
    }
    const anyAnswered = Object.values(fields).some(Boolean)

    const set = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [`sdr.${key}`, value]),
    )
    // Only stamp it when there is something to stamp; clearing every field is
    // how you delete the form, and a deleted form should not look filled in.
    set['sdr.filledAt'] = anyAnswered ? new Date() : null
    set['sdr.filledBy'] = anyAnswered ? String(await resolveActor(req)).slice(0, 200) : ''

    const result = await LeAgency.updateOne(
      { ori: String(req.params.ori).toUpperCase() },
      { $set: set },
    )
    if (!result.matchedCount) return res.status(404).json({ message: 'Agency was not found.' })

    const agency = await LeAgency.findOne({ ori: String(req.params.ori).toUpperCase() })
      .select('ori agencyName sdr')
      .lean()

    // Push to HubSpot, but never at the cost of the qualification itself. The
    // SDR's typing is the valuable artefact; the sync is a convenience, and a
    // HubSpot outage must not turn a saved form into a lost one.
    let hubspot = null
    if (anyAnswered) {
      try {
        hubspot = await syncAgencyToHubSpot(agency.ori)
      } catch (error) {
        const message = String(error?.message || error).slice(0, 300)
        hubspot = { error: message }
        await LeAgency.updateOne(
          { ori: agency.ori },
          { $set: { 'crm.hubspotSyncError': message } },
        )
      }
    }

    return res.json({ ori: agency.ori, name: agency.agencyName, sdr: agency.sdr || {}, hubspot })
  } catch (error) {
    return next(error)
  }
})

/** Newest call first - a log is read from the top. */
const sortedCalls = (calls = []) =>
  [...calls].sort(
    (a, b) => new Date(b.calledAt || b.loggedAt || 0) - new Date(a.calledAt || a.loggedAt || 0),
  )

/**
 * Recompute the denormalised summary from the log itself.
 *
 * Derived rather than incremented, so a deleted entry cannot leave the map
 * showing a blue pin for an agency whose only logged call was a mistake.
 */
const outreachFrom = (calls = []) => {
  const ordered = sortedCalls(calls)
  const latest = ordered[0] || null
  return {
    callCount: ordered.length,
    lastCalledAt: latest ? latest.calledAt || latest.loggedAt || null : null,
    lastOutcome: latest?.outcome || '',
    lastLoggedBy: latest?.loggedBy || '',
  }
}

/**
 * The call log for one agency.
 *
 * Shared like the qualification: one log per agency, not per user. An SDR
 * about to ring a department needs to see that somebody rang it on Tuesday and
 * was told to try back after the budget vote.
 */
router.get('/:ori/call-log', async (req, res, next) => {
  try {
    const agency = await LeAgency.findOne({ ori: String(req.params.ori).toUpperCase() })
      .select('ori agencyName callLog outreach')
      .lean()
    if (!agency) return res.status(404).json({ message: 'Agency was not found.' })
    return res.json({
      ori: agency.ori,
      name: agency.agencyName,
      calls: sortedCalls(agency.callLog),
      outreach: agency.outreach || null,
    })
  } catch (error) {
    return next(error)
  }
})

/** Add a call to the log. */
router.post('/:ori/call-log', async (req, res, next) => {
  try {
    const body = req.body || {}
    const text = (value, max = 2000) => String(value ?? '').slice(0, max).trim()
    const date = (value) => {
      const parsed = value ? new Date(value) : null
      return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
    }

    const clientCallId = text(body.clientCallId, 100)
    if (!clientCallId) {
      return res.status(400).json({ message: 'A call ID is required before saving.' })
    }
    const loggedBy = requireLoggedByEmail(await resolveActor(req))
    const entry = {
      clientCallId,
      calledAt: date(body.calledAt) || new Date(),
      contactName: text(body.contactName, 200),
      contactTitle: text(body.contactTitle, 200),
      phone: text(body.phone, 60),
      outcome: text(body.outcome, 60),
      followUpAt: date(body.followUpAt),
      notes: text(body.notes, 5000),
      loggedBy,
      loggedAt: new Date(),
    }
    // An entry with neither an outcome nor a word of notes records nothing but
    // a timestamp, and would still turn the pin blue. Refuse it.
    if (!entry.outcome && !entry.notes && !entry.contactName) {
      return res.status(400).json({ message: 'Add an outcome or some notes before saving.' })
    }

    const ori = String(req.params.ori).toUpperCase()
    let agency = await LeAgency.findOneAndUpdate(
      { ori, 'callLog.clientCallId': { $ne: clientCallId } },
      { $push: { callLog: entry } },
      { new: true },
    )
    if (!agency) agency = await LeAgency.findOne({ ori })
    if (!agency) return res.status(404).json({ message: 'Agency was not found.' })

    const savedEntry = agency.callLog.find((call) => call.clientCallId === clientCallId)
    if (!savedEntry) throw new Error('The saved Map call could not be reloaded.')
    agency.outreach = outreachFrom(agency.callLog)
    await agency.save()

    // The hub's log is the source of truth and must survive a HubSpot outage.
    // A failed sync is stamped for retry/backfill instead of turning a locally
    // saved call into an error in the SAE's browser.
    let hubspot = null
    try {
      hubspot = await syncMapCallToHubSpot(agency, savedEntry)
      savedEntry.hubspotCallId = hubspot.callId
      savedEntry.hubspotSyncedAt = new Date()
      savedEntry.hubspotSyncError = ''
    } catch (error) {
      savedEntry.hubspotSyncError = String(error?.message || error).slice(0, 300)
      hubspot = { error: savedEntry.hubspotSyncError }
    }
    try {
      await agency.save()
    } catch {
      // The call itself is already stored. A backfill reconciles the remote Call
      // by tt_map_call_id; do not make the SAE retry and create another local row
      // merely because the sync metadata could not be persisted.
    }

    return res.json({
      ori: agency.ori,
      name: agency.agencyName,
      calls: sortedCalls(agency.toObject().callLog),
      outreach: agency.outreach,
      hubspot,
    })
  } catch (error) {
    return next(error)
  }
})

/**
 * Clear the whole log for an agency.
 *
 * Separate from removing one call because it answers a different question:
 * not "that entry was wrong" but "we never actually worked this agency". It
 * puts the pin back to its camera colour, so it is deliberately a distinct,
 * confirmed action rather than something reachable by deleting entries one at
 * a time until the colour happens to change.
 */
router.delete('/:ori/call-log', async (req, res, next) => {
  try {
    const agency = await LeAgency.findOneAndUpdate(
      { ori: String(req.params.ori).toUpperCase() },
      { $set: { callLog: [], outreach: outreachFrom([]) } },
      { new: true },
    )
      .select('ori agencyName outreach')
      .lean()
    if (!agency) return res.status(404).json({ message: 'Agency was not found.' })

    return res.json({
      ori: agency.ori,
      name: agency.agencyName,
      calls: [],
      outreach: agency.outreach,
    })
  } catch (error) {
    return next(error)
  }
})

/** Remove one call from the log - a mis-logged call otherwise colours the pin for ever. */
router.delete('/:ori/call-log/:callId', async (req, res, next) => {
  try {
    const agency = await LeAgency.findOne({ ori: String(req.params.ori).toUpperCase() })
    if (!agency) return res.status(404).json({ message: 'Agency was not found.' })

    const entry = agency.callLog.id(req.params.callId)
    if (!entry) return res.status(404).json({ message: 'That call was not found.' })
    entry.deleteOne()
    agency.outreach = outreachFrom(agency.callLog)
    await agency.save()

    return res.json({
      ori: agency.ori,
      name: agency.agencyName,
      calls: sortedCalls(agency.toObject().callLog),
      outreach: agency.outreach,
    })
  } catch (error) {
    return next(error)
  }
})

/**
 * Call activity for a whole territory, rather than for one agency.
 *
 * The call log answers "what happened at this department"; nothing answered
 * "what happened this week", which is the question a territory gets managed by.
 * Scoped by the same filters the map is showing, so the report covers what the
 * person asking is actually looking at.
 *
 * The numbers are counted in Mongo and the words are written by Hermes from
 * those numbers - the same division as the traveller. He is given the call
 * notes, which is the part no table can show, and explicitly told not to do
 * arithmetic.
 */
const callReportInput = (source = {}) => ({
  filter: buildFilter(source),
  from: typeof source.from === 'string' ? source.from : '',
  to: typeof source.to === 'string' ? source.to : '',
  timezone: typeof source.timezone === 'string' ? source.timezone : 'UTC',
})

/** The figures on their own, for the preview in the report dialog. */
router.get('/call-report', async (req, res, next) => {
  try {
    const stats = await buildCallReportStats(callReportInput(req.query))
    // The notes are for Hermes, not for the browser: sixty call notes is a lot
    // of somebody else's typing to put on the wire for a dialog showing counts.
    res.json({ ...stats, notes: undefined, scopeLabel: describeFilters(req.query) })
  } catch (error) {
    next(error)
  }
})

/** The same period as a PDF, with the written summary. */
router.post('/call-report/pdf', async (req, res, next) => {
  try {
    const body = req.body || {}
    const source = { ...(body.filters || {}), from: body.from, to: body.to, timezone: body.timezone }
    const scopeLabel = describeFilters(source)
    const stats = await buildCallReportStats(callReportInput(source))

    // Never fatal. The counted figures are the part this document is
    // accountable for, and they are already in hand by the time Hermes is
    // asked for anything - a report without its summary beats a failed
    // download.
    const { narrative, error } = body.narrative === false
      ? { narrative: '', error: '' }
      : await generateCallReportNarrative(stats, { scopeLabel })

    const pdf = await createCallReportPdfBuffer(stats, {
      scopeLabel,
      narrative,
      narrativeError: error,
      generatedBy: await resolveActor(req),
    })

    // Named for the days the reader asked for, in their zone - a window ending
    // at midnight in Texas is the small hours of the next day in UTC, and a
    // file called "to-2026-09-11" for a report about the 10th invites an
    // argument about whether the numbers are a day out.
    const day = (value) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: stats.period.timezone }).format(new Date(value))
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="call-activity-${day(stats.period.from)}-to-${day(stats.period.to)}.pdf"`,
    )
    res.send(pdf)
  } catch (error) {
    next(error)
  }
})

// A briefing that is not cached researches the agency on the way, so it is
// gated like research-stream rather than like the plain agency read below.
router.get('/:ori/briefing', requireFullAccess, async (req, res, next) => {
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
