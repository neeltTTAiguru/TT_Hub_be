/**
 * Fills in the body-worn camera layer from every remaining public source.
 *
 * Four sources, and they are NOT equally good, which is the whole reason
 * `surveillance.bwc.evidence` exists:
 *
 *   nj        New Jersey's 2020 statewide survey. Direct evidence both ways -
 *             an agency reporting 0 cameras is a real "no", not a gap.
 *   sc        South Carolina's state grant programme FY2017-2023. Taking
 *             camera money means cameras, so this is a "yes" only.
 *   bja       Bureau of Justice Assistance federal camera grants 2015-2019.
 *             Same logic, national coverage.
 *   mandates  The eight states whose law requires body-worn cameras. This is
 *             the weakest class by far: a statute is a duty, not a purchase.
 *             Mandates carry funding and agency-type exceptions, and small
 *             departments lag, so this fills gaps and never overwrites.
 *
 * PRECEDENCE. Direct evidence (observed, surveyed) and inference (funded,
 * mandated) are ranked separately:
 *   - Among direct evidence the NEWER record wins, whichever kind it is: a
 *     2020 survey saying zero beats a 2016 sighting, and vice versa.
 *   - Inference NEVER overwrites direct evidence. It only fills unknowns.
 * Without that split, a statewide mandate would silently repaint thousands of
 * agencies "yes" over survey answers that said otherwise.
 *
 * Usage:
 *   node scripts/ingestBwcSupplements.js --source=all --dry-run
 *   node scripts/ingestBwcSupplements.js --source=nj
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'

dotenv.config()

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')

// Statewide statutory requirements. Sourced from the NCSL Body-Worn Camera
// Laws Database; re-check it before trusting this list, because states join it.
const MANDATE_STATES = ['CO', 'CT', 'DE', 'IL', 'MD', 'NJ', 'NM', 'SC']
const MANDATE_URL = 'https://www.ncsl.org/civil-and-criminal-justice/body-worn-camera-laws-database'

const DIRECT = new Set(['observed', 'surveyed'])

const parseArgs = () => {
  const args = {}
  for (const raw of process.argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=')
    args[key] = value === undefined ? true : value
  }
  return args
}

const normaliseName = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\b(police|department|dept|sheriff'?s?|office|of|the|county|city|township|twp|boro|borough|state|division|div|bureau)\b/g, '')
    .replace(/[^a-z]/g, '')

/**
 * Should this new claim replace what is already stored?
 *
 * Inference never beats direct evidence. Two pieces of direct evidence are
 * settled by date, so the map reflects the most recent thing anyone actually
 * established rather than whichever source was ingested last.
 */
const shouldReplace = (current, next) => {
  const currentEvidence = current?.evidence || ''
  if (!currentEvidence || current?.status === 'unknown') return true
  const currentDirect = DIRECT.has(currentEvidence)
  const nextDirect = DIRECT.has(next.evidence)
  if (nextDirect && !currentDirect) return true
  if (!nextDirect && currentDirect) return false
  if (!nextDirect && !currentDirect) return false // keep the first inference
  const currentAt = current?.asOf ? new Date(current.asOf).getTime() : 0
  return next.asOf.getTime() > currentAt
}

/** New Jersey 2020: agency name + camera count, per county worksheet. */
const readNewJersey = async () => {
  const file = path.join(DATA_DIR, 'nj-bwc-survey-2020.xlsx')
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`)
  const { execFileSync } = await import('node:child_process')
  const script = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
out = []
for sheet in wb.sheetnames:
    if sheet == 'Read Me':
        continue
    started = False
    for row in wb[sheet].iter_rows(values_only=True):
        if not row:
            continue
        first = str(row[0] or '').strip()
        if not started:
            if first.upper().startswith('AGENCY'):
                started = True
            continue
        if not first:
            continue
        count = next((c for c in row[1:] if isinstance(c, (int, float))), None)
        if count is None:
            continue
        out.append({'name': first, 'count': float(count)})
print(json.dumps(out))
`
  const raw = execFileSync('python3', ['-c', script, file], { maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(raw.toString()).map((row) => ({
    state: 'NJ',
    name: row.name,
    status: row.count > 0 ? 'yes' : 'no',
    evidence: 'surveyed',
    asOf: new Date(Date.UTC(2020, 8, 30)),
    source: 'nj_statewide_bwc_survey_2020',
    sourceUrl: 'https://www.nj.gov/oag/newsreleases20/2020-BWC-Survey_FULL.pdf',
  }))
}

/** BJA federal camera grants 2015-2019: recipient + state, "yes" only. */
const readBja = () => {
  const file = path.join(DATA_DIR, 'bja-bwc-2015-2019.csv')
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`)
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  const header = lines.shift().split(',')
  const iName = header.findIndex((h) => /Grant Recipient/i.test(h))
  const iState = header.findIndex((h) => /^State$/i.test(h.trim()))
  const out = []
  for (const line of lines) {
    // Recipient names contain quoted commas ("Akron, City of").
    const cells = line.match(/("([^"]*)")|([^,]*)/g).filter((_, i) => i % 2 === 0)
    const name = String(cells[iName] || '').replace(/^"|"$/g, '').trim()
    const state = String(cells[iState] || '').trim().toUpperCase()
    if (!name || state.length !== 2) continue
    out.push({
      state,
      name,
      status: 'yes',
      evidence: 'funded',
      asOf: new Date(Date.UTC(2019, 11, 31)),
      source: 'bja_bwc_program_2015_2019',
      sourceUrl: 'https://www.eff.org/document/bureau-justice-assistance-body-worn-camera-program-data',
    })
  }
  return out
}

/** Every agency in a statewide-mandate state that we still know nothing about. */
const applyMandates = async ({ dryRun }) => {
  const pending = await LeAgency.find({
    state: { $in: MANDATE_STATES },
    $or: [
      { 'surveillance.bwc.status': { $exists: false } },
      { 'surveillance.bwc.status': 'unknown' },
    ],
  })
    .select('ori')
    .lean()

  console.log(`\nmandates: ${pending.length} agencies in ${MANDATE_STATES.join(',')} still unknown`)
  if (dryRun) {
    console.log('  (dry run - nothing written)')
    return 0
  }
  const importedAt = new Date()
  const operations = pending.map((agency) => ({
    updateOne: {
      filter: { ori: agency.ori },
      update: {
        $set: {
          'surveillance.bwc.status': 'yes',
          'surveillance.bwc.hasBwc': true,
          'surveillance.bwc.evidence': 'mandated',
          'surveillance.bwc.asOf': null,
          'surveillance.bwc.source': 'ncsl_state_mandate',
          'surveillance.bwc.evidenceUrl': MANDATE_URL,
          'surveillance.bwc.importedAt': importedAt,
        },
        $addToSet: {
          provenance: { source: 'ncsl_state_mandate', url: MANDATE_URL, retrievedAt: importedAt },
        },
      },
    },
  }))
  let written = 0
  for (let i = 0; i < operations.length; i += 1000) {
    const result = await LeAgency.bulkWrite(operations.slice(i, i + 1000), { ordered: false })
    written += result.modifiedCount
  }
  console.log(`  written: ${written}`)
  return written
}

/** Name-matched sources: unique name within state, or it is skipped. */
const applyNameMatched = async (label, records, { dryRun }) => {
  const byState = new Map()
  for (const record of records) {
    if (!byState.has(record.state)) byState.set(record.state, null)
  }
  for (const state of byState.keys()) {
    byState.set(
      state,
      await LeAgency.find({ state }).select('ori agencyName surveillance.bwc').lean(),
    )
  }

  const stats = { rows: records.length, unique: 0, ambiguous: 0, none: 0, skipped: 0, write: 0 }
  const importedAt = new Date()
  const operations = []
  const seen = new Set()
  for (const record of records) {
    const candidates = byState.get(record.state) || []
    const target = normaliseName(record.name)
    if (!target) continue
    const hits = candidates.filter((c) => normaliseName(c.agencyName) === target)
    if (hits.length !== 1) {
      if (hits.length > 1) stats.ambiguous += 1
      else stats.none += 1
      continue
    }
    stats.unique += 1
    const agency = hits[0]
    if (seen.has(agency.ori)) continue
    if (!shouldReplace(agency.surveillance?.bwc, record)) {
      stats.skipped += 1
      continue
    }
    seen.add(agency.ori)
    operations.push({
      updateOne: {
        filter: { ori: agency.ori },
        update: {
          $set: {
            'surveillance.bwc.status': record.status,
            'surveillance.bwc.hasBwc': record.status === 'yes',
            'surveillance.bwc.evidence': record.evidence,
            'surveillance.bwc.asOf': record.asOf,
            'surveillance.bwc.source': record.source,
            'surveillance.bwc.evidenceUrl': record.sourceUrl,
            'surveillance.bwc.importedAt': importedAt,
          },
          $addToSet: {
            provenance: { source: record.source, url: record.sourceUrl, retrievedAt: importedAt },
          },
        },
      },
    })
  }
  stats.write = operations.length
  console.log(`\n${label}: ${stats.rows} rows`)
  console.log(`  unique name+state match : ${stats.unique}`)
  console.log(`  ambiguous / no match    : ${stats.ambiguous} / ${stats.none}`)
  console.log(`  outranked by what we had: ${stats.skipped}`)
  console.log(`  to write                : ${stats.write}`)
  if (dryRun) {
    console.log('  (dry run - nothing written)')
    return 0
  }
  let written = 0
  for (let i = 0; i < operations.length; i += 1000) {
    const result = await LeAgency.bulkWrite(operations.slice(i, i + 1000), { ordered: false })
    written += result.modifiedCount
  }
  console.log(`  written                 : ${written}`)
  return written
}

const run = async () => {
  const args = parseArgs()
  const dryRun = args['dry-run'] === true
  const source = String(args.source || 'all')
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) throw new Error('MONGODB_URI is not set.')
  await mongoose.connect(uri)

  // Ordered weakest-last so the stronger sources claim agencies first.
  if (source === 'nj' || source === 'all') {
    await applyNameMatched('New Jersey 2020 survey', await readNewJersey(), { dryRun })
  }
  if (source === 'bja' || source === 'all') {
    await applyNameMatched('BJA federal grants 2015-2019', readBja(), { dryRun })
  }
  if (source === 'mandates' || source === 'all') {
    await applyMandates({ dryRun })
  }

  const summary = await LeAgency.aggregate([
    { $match: { 'surveillance.bwc.status': { $in: ['yes', 'no'] } } },
    {
      $group: {
        _id: { status: '$surveillance.bwc.status', evidence: '$surveillance.bwc.evidence' },
        n: { $sum: 1 },
      },
    },
    { $sort: { n: -1 } },
  ])
  const total = await LeAgency.countDocuments()
  const known = summary.reduce((sum, row) => sum + row.n, 0)
  console.log('\nCamera layer now:')
  for (const row of summary) {
    console.log(`  ${row._id.status.padEnd(4)} / ${String(row._id.evidence).padEnd(9)} ${row.n}`)
  }
  console.log(`  ---- ${known} of ${total} (${((known / total) * 100).toFixed(1)}%), unknown ${total - known}`)

  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
