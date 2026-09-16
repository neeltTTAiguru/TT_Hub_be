/**
 * Rebuilds the research log (agencyresearchlog) from everything that already
 * exists: the agency records, every run's trail, and the briefings.
 *
 * Safe to run again - each agency's document is replaced wholesale, so a
 * second pass produces the same result as the first. From now on the research
 * paths write the log as they go; this is for the work that happened before
 * there was a log to write to.
 *
 * What counts as "researched": a camera research stamp, a leadership check,
 * a hand-set verdict, a stop on any run, or a briefing. Anything else on the
 * agency (Atlas sightings, LEMAS survey answers, mandates) is imported data,
 * not research, and is not in here.
 *
 * Usage:
 *   node scripts/backfillAgencyResearchLog.js --dry-run
 *   node scripts/backfillAgencyResearchLog.js
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'
import BwcResearchRun from '../src/models/BwcResearchRun.js'
import AgencyBriefing from '../src/models/AgencyBriefing.js'
import AgencyResearchLog from '../src/models/AgencyResearchLog.js'
import { snapshotFromAgency } from '../src/services/agencyResearchLog.js'

dotenv.config()

const dryRun = process.argv.includes('--dry-run')
const HISTORY_CAP = 100

const RESEARCHED = {
  $or: [
    { 'enrichment.bwcResearchedAt': { $ne: null } },
    { 'enrichment.leadershipCheckedAt': { $ne: null } },
    { 'surveillance.bwc.trustedResearched': { $in: ['has_bwc', 'no_bwc'] } },
  ],
}

const entryFromStop = (run, stop) => ({
  at: stop.at || run.startedAt || run.createdAt,
  source: 'run',
  runId: String(run._id),
  by: run.startedBy || '',
  searches: stop.searches || 0,
  error: stop.error || '',
  cameras: {
    verdict: stop.cameras?.verdict || stop.verdict || '',
    reasoning: stop.cameras?.reasoning || '',
    sourceUrl: stop.cameras?.sourceUrl || '',
    confidence: stop.cameras?.confidence || '',
    vendor: stop.cameras?.vendor || '',
    contractEnd: stop.cameras?.contractEnd || '',
  },
  contact: {
    chiefName: stop.contact?.chiefName || '',
    chiefTitle: stop.contact?.chiefTitle || '',
    email: stop.contact?.email || '',
    phone: stop.contact?.phone || '',
    website: stop.contact?.website || '',
    sourceUrl: stop.contact?.sourceUrl || '',
  },
  added: {
    cameras: Boolean(stop.added?.cameras),
    email: Boolean(stop.added?.email),
    phone: Boolean(stop.added?.phone),
    chief: Boolean(stop.added?.chief),
  },
})

/** The current columns as a history entry, dated to when the agency says. */
const entryFromAgency = (snapshot, at, source) => ({
  at,
  source,
  runId: '',
  by: '',
  searches: snapshot.cameras.searchesRun || 0,
  error: '',
  cameras: {
    verdict:
      snapshot.cameras.trustedVerdict === 'has_bwc'
        ? 'yes'
        : snapshot.cameras.trustedVerdict === 'no_bwc'
          ? 'no'
          : snapshot.cameras.verdict || 'unknown',
    reasoning: snapshot.cameras.reasoning,
    sourceUrl: snapshot.cameras.sourceUrl,
    confidence: snapshot.cameras.confidence,
    vendor: snapshot.cameras.vendor,
    contractEnd: snapshot.cameras.contractEnd
      ? new Date(snapshot.cameras.contractEnd).toISOString().slice(0, 10)
      : '',
  },
  contact: {
    chiefName: snapshot.contact.chiefName,
    chiefTitle: snapshot.contact.chiefTitle,
    email: snapshot.contact.email,
    phone: snapshot.contact.phone,
    website: snapshot.contact.website,
    sourceUrl: snapshot.contact.chiefSourceUrl,
  },
  added: { cameras: false, email: false, phone: false, chief: false },
})

const run = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) throw new Error('MONGODB_URI is not set.')
  await mongoose.connect(uri)

  // Every research event we can find, keyed by ORI.
  const events = new Map()
  const push = (ori, entry) => {
    if (!ori || !entry.at) return
    if (!events.has(ori)) events.set(ori, [])
    events.get(ori).push(entry)
  }

  const runs = await BwcResearchRun.find({}).sort({ startedAt: 1 }).lean()
  let stops = 0
  for (const r of runs) {
    for (const stop of r.path || []) {
      if (!stop.ori) continue
      push(stop.ori, entryFromStop(r, stop))
      stops += 1
    }
  }

  const briefings = await AgencyBriefing.find({})
    .select('ori generatedAt searchCount research.bwcStatus')
    .lean()
  for (const b of briefings) {
    if (!b.generatedAt) continue
    const found = b.research?.bwcStatus || {}
    push(b.ori, {
      at: b.generatedAt,
      source: 'briefing',
      runId: '',
      by: '',
      searches: b.searchCount || 0,
      error: '',
      cameras: {
        verdict: found.hasProgram || '',
        reasoning: String(found.details || '').slice(0, 600),
        sourceUrl: String(found.sourceUrl || ''),
        confidence: found.confidence || '',
        vendor: found.vendor || '',
        contractEnd: '',
      },
      contact: { chiefName: '', chiefTitle: '', email: '', phone: '', website: '', sourceUrl: '' },
      added: { cameras: false, email: false, phone: false, chief: false },
    })
  }

  const where = { $or: [RESEARCHED, { ori: { $in: [...events.keys()] } }] }
  const agencies = await LeAgency.find(where)
    .select('ori agencyName state county agencyType employment.swornOfficers contacts surveillance.bwc enrichment')
    .lean()

  const ops = []
  let synthesised = 0
  for (const agency of agencies) {
    const snapshot = snapshotFromAgency(agency)
    const bwc = agency.surveillance?.bwc || {}
    const enrichment = agency.enrichment || {}
    const history = [...(events.get(agency.ori) || [])]

    // A hand-set verdict is its own event, dated when it was set.
    if (bwc.trustedResearchedBy === 'manual' && bwc.trustedResearchedAt) {
      history.push(entryFromAgency(snapshot, bwc.trustedResearchedAt, 'manual'))
    }

    // Researched, but nothing on record says when by whom - the leadership
    // batch and early camera sweeps predate the run trail. One entry, dated to
    // the agency's own stamp, so the row still says when it was last touched.
    if (!history.length) {
      const stamps = [enrichment.bwcResearchedAt, enrichment.leadershipCheckedAt]
        .filter(Boolean)
        .map((d) => new Date(d).getTime())
      if (!stamps.length) continue
      history.push(entryFromAgency(snapshot, new Date(Math.max(...stamps)), 'backfill'))
      synthesised += 1
    }

    history.sort((a, b) => new Date(a.at) - new Date(b.at))
    const kept = history.slice(-HISTORY_CAP)
    const last = kept[kept.length - 1]
    const stampMax = Math.max(
      new Date(last.at).getTime(),
      ...[enrichment.bwcResearchedAt, enrichment.leadershipCheckedAt]
        .filter(Boolean)
        .map((d) => new Date(d).getTime()),
    )

    ops.push({
      replaceOne: {
        filter: { ori: agency.ori },
        replacement: {
          ori: agency.ori,
          ...snapshot,
          firstResearchedAt: history[0].at,
          lastResearchedAt: new Date(stampMax),
          timesResearched: history.length,
          lastSource: last.source,
          lastRunId: last.runId,
          history: kept,
        },
        upsert: true,
      },
    })
  }

  console.log(
    `${runs.length} runs (${stops} stops), ${briefings.length} briefings, ${agencies.length} researched agencies -> ${ops.length} log documents (${synthesised} with no dated event, stamped from the agency)`,
  )

  if (dryRun) {
    console.log('Dry run - nothing written.')
  } else {
    let written = 0
    for (let i = 0; i < ops.length; i += 500) {
      const result = await AgencyResearchLog.bulkWrite(ops.slice(i, i + 500), { ordered: false })
      written += (result.upsertedCount || 0) + (result.modifiedCount || 0) + (result.matchedCount || 0)
    }
    console.log(`Wrote ${ops.length} documents. Collection now holds ${await AgencyResearchLog.countDocuments()}.`)
  }

  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
