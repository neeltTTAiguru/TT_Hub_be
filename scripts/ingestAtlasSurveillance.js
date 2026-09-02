/**
 * Marks which agencies are known to run body-worn cameras.
 *
 * The EFF / Reynolds School "Atlas of Surveillance" is the only public file
 * that names surveillance technology per agency AND carries the FBI ORI, so it
 * joins straight onto our agencies with no name matching. Export it from
 *
 *   https://www.atlasofsurveillance.org/search?technologies%5B%5D=body-worn-cameras
 *
 * Three things about this data decide how it is stored, and they are worth
 * reading before trusting anything downstream:
 *
 *   1. It is evidence of a SIGHTING, not an install base. A row means someone
 *      documented a camera once - the 2026-09-02 export cites articles going
 *      back to 2012. It does not mean the agency still runs that vendor, and
 *      the date is not a renewal date.
 *   2. `Vendor` is blank on ~73% of rows. Vendor tallies are a floor on that
 *      vendor's footprint, never a market share.
 *   3. Agencies with no known ORI get a synthetic `XX…` placeholder, which can
 *      never join. Those are skipped and counted, not guessed at.
 *
 * The ORI column is `NEWAOSNUMBER (ORI9)`: an ORI9 with the technology code
 * appended, e.g. `VA0850300BWC`. Strip the suffix and it is our `ori`.
 *
 * Usage:
 *   node scripts/ingestAtlasSurveillance.js --dry-run
 *   node scripts/ingestAtlasSurveillance.js --file=data/atlas-surveillance-bwc-20260902.csv
 *   node scripts/ingestAtlasSurveillance.js --recover-names   # second pass, see below
 *   node scripts/ingestAtlasSurveillance.js --clear     # drop the layer and stop
 *
 * --recover-names is a SECOND pass for the rows the ORI join missed: the Atlas
 * assigns synthetic XX ids when it has no ORI, and some real ORIs are stale
 * against the FBI roster. Those rows are matched on normalised name within
 * state, and ONLY when exactly one agency in that state matches - an ambiguous
 * name is left alone rather than guessed at. Recovered rows are stamped with a
 * different source so a name match is never mistaken for an ORI match.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'

dotenv.config()

const SOURCE_NAME = 'atlas_of_surveillance'
// Deliberately distinct: a name match is weaker evidence than an ORI match and
// must stay separable, both for auditing and for undoing just this pass.
const SOURCE_NAME_MATCHED = 'atlas_of_surveillance_namematch'
const SOURCE_URL = 'https://atlasofsurveillance.org/search?technologies%5B%5D=body-worn-cameras'
const DEFAULT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'atlas-surveillance-bwc-20260902.csv',
)
const BATCH_SIZE = 1000

const parseArgs = () => {
  const args = {}
  for (const raw of process.argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=')
    args[key] = value === undefined ? true : value
  }
  return args
}

/**
 * RFC4180 CSV reader.
 *
 * The Atlas summaries are free text containing commas, quoted quotes, and
 * newlines inside fields, so splitting on commas mangles roughly a fifth of the
 * file. This walks character by character instead.
 */
const parseCsv = (text) => {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char !== '"') cell += char
      else if (text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else quoted = false
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') cell += char
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/**
 * One vendor, one spelling.
 *
 * The export carries 'Motorola' and 'Motorola Solutions' as separate values,
 * and 'WatchGuard' and 'Watchguard' likewise; WatchGuard's in-car and body
 * camera line was acquired by Motorola, so they are reported as one. Anything
 * unrecognised is passed through with its original spelling rather than
 * dropped, so a new vendor shows up as itself instead of vanishing.
 */
const normaliseVendor = (raw) => {
  const value = (raw || '').trim()
  if (!value) return ''
  const key = value.toLowerCase()
  if (key.includes('axon') || key.includes('taser')) return 'Axon'
  if (key.includes('motorola') || key.includes('watchguard')) return 'Motorola/WatchGuard'
  if (key.includes('wolfcom')) return 'Wolfcom'
  if (key.includes('coreforce')) return 'Coreforce'
  if (key.includes('coban')) return 'Coban'
  if (key.includes('getac')) return 'Getac'
  if (key.includes('lenslock')) return 'LensLock'
  if (key.includes('panasonic')) return 'Panasonic'
  if (key.includes('pro-vision') || key.includes('provision')) return 'Pro-Vision'
  if (key.includes('digital ally')) return 'Digital Ally'
  if (key.includes('utility')) return 'Utility'
  return value
}

/** MM/DD/YYYY as published. Anything else is left null rather than guessed. */
const parseDate = (raw) => {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((raw || '').trim())
  if (!match) return null
  const [, month, day, year] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return Number.isNaN(date.getTime()) ? null : date
}

/** Strip the words that differ between rosters so only the identity is left. */
const normaliseName = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\b(police|department|dept|sheriff|office|of|the|county|city|state|div|division)\b/g, '')
    .replace(/[^a-z]/g, '')

const clearLayer = async () => {
  const result = await LeAgency.updateMany(
    { 'surveillance.bwc.hasBwc': true },
    { $unset: { 'surveillance.bwc': '' } },
  )
  console.log(`Cleared the body-worn camera layer from ${result.modifiedCount} agencies.`)
}

/**
 * Second pass over the rows the ORI join could not place.
 *
 * Matches on normalised name within state, and only commits when EXACTLY one
 * agency in that state matches. Two "Springfield Police Department"s in the
 * same state means neither is written - a wrong agency marked as owning
 * cameras is worse than one left unmarked.
 */
const recoverByName = async (records, { dryRun }) => {
  const stats = { considered: 0, unique: 0, ambiguous: 0, alreadyFlagged: 0, written: 0 }
  const byState = new Map()
  for (const record of records) {
    if (!record.state || !record.name) continue
    stats.considered += 1
    if (!byState.has(record.state)) byState.set(record.state, null)
  }
  for (const state of byState.keys()) {
    const agencies = await LeAgency.find({ state })
      .select('ori agencyName surveillance.bwc.hasBwc')
      .lean()
    byState.set(state, agencies)
  }

  const importedAt = new Date()
  const operations = []
  for (const record of records) {
    if (!record.state || !record.name) continue
    const agencies = byState.get(record.state) || []
    const target = normaliseName(record.name)
    const hits = agencies.filter((agency) => normaliseName(agency.agencyName) === target)
    if (hits.length !== 1) {
      if (hits.length > 1) stats.ambiguous += 1
      continue
    }
    stats.unique += 1
    if (hits[0].surveillance?.bwc?.hasBwc) {
      stats.alreadyFlagged += 1
      continue
    }
    operations.push({
      updateOne: {
        filter: { ori: hits[0].ori },
        update: {
          $set: {
            'surveillance.bwc': {
              hasBwc: true,
              vendor: record.vendor,
              vendorRaw: record.vendorRaw,
              summary: record.summary,
              evidenceUrl: record.evidenceUrl,
              evidenceDate: record.evidenceDate,
              aosNumber: record.aosNumber,
              source: SOURCE_NAME_MATCHED,
              importedAt,
            },
          },
          $addToSet: {
            provenance: { source: SOURCE_NAME_MATCHED, url: SOURCE_URL, retrievedAt: importedAt },
          },
        },
      },
    })
  }

  console.log(`\nName-recovery pass over ${stats.considered} unjoined rows:`)
  console.log(`  unique name+state match : ${stats.unique}`)
  console.log(`  ambiguous, left alone   : ${stats.ambiguous}`)
  console.log(`  already flagged via ORI : ${stats.alreadyFlagged}`)
  console.log(`  to write                : ${operations.length}`)
  if (dryRun) {
    console.log('  (dry run - nothing written)')
    return stats
  }
  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    const result = await LeAgency.bulkWrite(operations.slice(i, i + BATCH_SIZE), { ordered: false })
    stats.written += result.modifiedCount
  }
  console.log(`  written                 : ${stats.written}`)
  return stats
}

const run = async () => {
  const args = parseArgs()
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) throw new Error('MONGODB_URI is not set.')
  await mongoose.connect(uri)

  if (args.clear) {
    await clearLayer()
    await mongoose.disconnect()
    return
  }

  const file = args.file ? path.resolve(args.file) : DEFAULT_FILE
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`)

  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  const header = rows.shift()
  const col = (name) => {
    const index = header.indexOf(name)
    if (index === -1) throw new Error(`Column "${name}" is missing. Did the Atlas export change?`)
    return index
  }
  const iOri = col('NEWAOSNUMBER (ORI9)')
  const iAos = col('AOSNUMBER')
  const iVendor = col('Vendor')
  const iSummary = col('Summary')
  const iLink = col('Link 1')
  const iDate = col('Link 1 Date')

  const iAgency = col('Agency')
  const iState = col('State')

  const stats = { rows: 0, placeholder: 0, noOri: 0, unique: 0, matched: 0, unmatched: 0 }
  const byOri = new Map()
  // Rows the ORI join cannot place, kept for the --recover-names pass.
  const unjoined = []
  const rowRecord = (row) => ({
    name: (row[iAgency] || '').trim(),
    state: (row[iState] || '').trim().toUpperCase(),
    vendorRaw: (row[iVendor] || '').trim(),
    vendor: normaliseVendor(row[iVendor]),
    summary: (row[iSummary] || '').trim(),
    evidenceUrl: (row[iLink] || '').trim(),
    evidenceDate: parseDate(row[iDate]),
    aosNumber: (row[iAos] || '').trim(),
  })

  for (const row of rows) {
    if (row.length < header.length - 2) continue
    stats.rows += 1
    const rawOri = (row[iOri] || '').trim().toUpperCase()
    if (!rawOri) {
      stats.noOri += 1
      unjoined.push(rowRecord(row))
      continue
    }
    // Synthetic ids the Atlas assigns when it has no real ORI. They cannot join.
    if (rawOri.startsWith('XX')) {
      stats.placeholder += 1
      unjoined.push(rowRecord(row))
      continue
    }
    const ori = rawOri.replace(/BWC$/, '')
    const vendorRaw = (row[iVendor] || '').trim()
    // Last row wins on a duplicate ORI, except that a row naming a vendor is
    // always preferred over one that does not.
    const existing = byOri.get(ori)
    if (existing && existing.vendorRaw && !vendorRaw) continue
    byOri.set(ori, rowRecord(row))
  }
  stats.unique = byOri.size

  const oris = [...byOri.keys()]
  const known = new Set(
    (await LeAgency.find({ ori: { $in: oris } }).select('ori').lean()).map((a) => a.ori),
  )
  stats.matched = known.size
  stats.unmatched = oris.length - known.size
  for (const ori of oris) {
    if (!known.has(ori)) unjoined.push(byOri.get(ori))
  }

  console.log(`Read ${stats.rows} rows from ${path.basename(file)}`)
  console.log(`  unique joinable ORIs : ${stats.unique}`)
  console.log(`  XX placeholders      : ${stats.placeholder} (no ORI published, cannot join)`)
  console.log(`  matched in the db    : ${stats.matched}`)
  console.log(`  not in the db        : ${stats.unmatched}`)

  if (args['recover-names']) {
    await recoverByName(unjoined, { dryRun: args['dry-run'] === true })
    await mongoose.disconnect()
    return
  }

  if (args['dry-run']) {
    console.log('\nDry run: nothing was written.')
    await mongoose.disconnect()
    return
  }

  const importedAt = new Date()
  const operations = []
  for (const ori of oris) {
    if (!known.has(ori)) continue
    const record = byOri.get(ori)
    operations.push({
      updateOne: {
        filter: { ori },
        update: {
          $set: {
            'surveillance.bwc': {
              hasBwc: true,
              vendor: record.vendor,
              vendorRaw: record.vendorRaw,
              summary: record.summary,
              evidenceUrl: record.evidenceUrl,
              evidenceDate: record.evidenceDate,
              aosNumber: record.aosNumber,
              source: SOURCE_NAME,
              importedAt,
            },
          },
          $addToSet: {
            provenance: { source: SOURCE_NAME, url: SOURCE_URL, retrievedAt: importedAt },
          },
        },
      },
    })
  }

  let written = 0
  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    const batch = operations.slice(i, i + BATCH_SIZE)
    const result = await LeAgency.bulkWrite(batch, { ordered: false })
    written += result.modifiedCount + result.upsertedCount
    console.log(`  wrote ${Math.min(i + BATCH_SIZE, operations.length)}/${operations.length}`)
  }

  const vendorMix = await LeAgency.aggregate([
    { $match: { 'surveillance.bwc.hasBwc': true } },
    { $group: { _id: '$surveillance.bwc.vendor', agencies: { $sum: 1 } } },
    { $sort: { agencies: -1 } },
  ])

  console.log(`\nMarked ${written} agencies as running body-worn cameras.`)
  console.log('Vendor mix (blank = documented camera, undocumented vendor):')
  for (const entry of vendorMix) {
    console.log(`  ${String(entry.agencies).padStart(5)}  ${entry._id || '(vendor not published)'}`)
  }

  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
