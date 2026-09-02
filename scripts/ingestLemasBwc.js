/**
 * Adds the 2016 LEMAS Body-Worn Camera Supplement, which is the only source we
 * have that can say an agency does NOT have cameras.
 *
 * The Atlas of Surveillance records sightings, so it can only ever produce a
 * "yes"; every agency it has never heard of looks identical to one that has
 * genuinely never bought a camera. LEMAS asked ~3,900 agencies directly, and
 * roughly half of them said no - and said why.
 *
 * Get it from https://www.icpsr.umich.edu/web/NACJD/studies/37302 (free
 * account, choose the "Delimited" download) and point --file at
 * DS0001/37302-0001-Data.tsv.
 *
 * TWO THINGS DECIDE HOW THIS IS STORED:
 *
 *   1. There is no single yes/no column. The questionnaire branches: agencies
 *      WITH cameras answer Q_11-Q_60, agencies WITHOUT answer Q61-Q66. Which
 *      block a row filled in is the answer. Q_12 and Q_63 are used as the
 *      sentinels for each branch.
 *   2. A 2016 "no" is not a 2026 "no". 748 agencies that said no in 2016 have
 *      since had a camera documented by the Atlas - and that is a floor, since
 *      the Atlas only catches agencies somebody wrote about. So an existing
 *      'observed' record always wins, and a survey answer never overwrites a
 *      sighting. It is recorded with asOf=2016 so its age stays visible.
 *
 * Usage:
 *   node scripts/ingestLemasBwc.js --file=/path/37302-0001-Data.tsv --dry-run
 *   node scripts/ingestLemasBwc.js --file=/path/37302-0001-Data.tsv
 *   node scripts/ingestLemasBwc.js --remove            # take 2016 back out
 *   node scripts/ingestLemasBwc.js --remove --only=no  # just the negatives
 *
 * --remove exists because this data ages badly and the map presented it as
 * fact. Records superseded by a later source are left alone; only rows still
 * sourced to LEMAS are reverted to unknown.
 */
import fs from 'node:fs'
import path from 'node:path'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'

dotenv.config()

const SOURCE_NAME = 'lemas_bwcs_2016'
const SOURCE_URL = 'https://doi.org/10.3886/ICPSR37302.v1'
// The survey reference date, not the publication date. Everything from this
// file is nine years old and must be comparable against newer evidence.
const AS_OF = new Date(Date.UTC(2016, 11, 31))

// Q61 is "why has your agency not acquired body-worn cameras", asked only of
// non-users. Labels from the codebook, kept short enough to show on a card.
const DECLINE_REASONS = {
  Q61M1: 'Cost of cameras',
  Q61M2: 'Cost of storage',
  Q61M3: 'Cost of training',
  Q61M4: 'Cost of administering',
  Q61M5: 'Budget constraints',
  Q61M6: 'Privacy concerns',
  Q61M7: 'Officer resistance',
  Q61M8: 'Data storage requirements',
  Q61M9: 'Public records burden',
  Q61M10: 'No perceived need',
  Q61M11: 'Legal or policy uncertainty',
  Q61M12: 'Technology limitations',
  Q61M13: 'Staffing to manage footage',
  Q61M14: 'Union or bargaining issues',
}

const parseArgs = () => {
  const args = {}
  for (const raw of process.argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=')
    args[key] = value === undefined ? true : value
  }
  return args
}

const filled = (value) => {
  const trimmed = String(value ?? '').trim()
  return trimmed !== '' && trimmed !== '.' && trimmed !== '-9'
}

/**
 * Take LEMAS back out.
 *
 * The negatives are the dangerous half: an agency that said "yes" in 2016
 * almost certainly still has cameras, because adoption does not reverse - but
 * a 2016 "no" has had nine years, a national funding wave and eight state
 * mandates to stop being true, and 748 of them are already contradicted by a
 * photographed camera. Hence --only=no.
 */
const removeLemas = async ({ dryRun, only }) => {
  const filter = { 'surveillance.bwc.source': SOURCE_NAME }
  if (only === 'no' || only === 'yes') filter['surveillance.bwc.status'] = only

  const byStatus = await LeAgency.aggregate([
    { $match: { 'surveillance.bwc.source': SOURCE_NAME } },
    { $group: { _id: '$surveillance.bwc.status', n: { $sum: 1 } } },
  ])
  console.log('Records still sourced to LEMAS 2016:')
  for (const row of byStatus) console.log(`  ${String(row._id).padEnd(8)} ${row.n}`)

  const affected = await LeAgency.countDocuments(filter)
  console.log(`\nWould revert to unknown: ${affected}${only ? ` (--only=${only})` : ''}`)
  if (dryRun) {
    console.log('  (dry run - nothing written)')
    return
  }
  const result = await LeAgency.updateMany(filter, {
    $unset: { 'surveillance.bwc': '' },
    $pull: { provenance: { source: SOURCE_NAME } },
  })
  console.log(`  reverted: ${result.modifiedCount}`)
}

const run = async () => {
  const args = parseArgs()
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) throw new Error('MONGODB_URI is not set.')
  if (args.remove) {
    await mongoose.connect(uri)
    await removeLemas({ dryRun: args['dry-run'] === true, only: args.only })
    await mongoose.disconnect()
    return
  }
  if (!args.file) throw new Error('Pass --file=/path/to/37302-0001-Data.tsv')
  const file = path.resolve(args.file)
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`)

  await mongoose.connect(uri)

  // latin-1: the file carries a stray 0xa7 that is not valid UTF-8.
  const lines = fs.readFileSync(file, 'latin1').split('\n').filter((line) => line.trim())
  const header = lines.shift().split('\t')
  const index = (name) => {
    const at = header.indexOf(name)
    if (at === -1) throw new Error(`Column "${name}" is missing. Is this really LEMAS-BWCS 2016?`)
    return at
  }
  const iOri = index('ORI9')
  const iUser = index('Q_12')
  const iNonUser = index('Q_63')
  const reasonCols = Object.entries(DECLINE_REASONS)
    .filter(([col]) => header.includes(col))
    .map(([col, label]) => [header.indexOf(col), label])

  const records = []
  for (const line of lines) {
    const cells = line.split('\t')
    const ori = String(cells[iOri] || '').trim().toUpperCase()
    if (!ori || ori.length < 7) continue
    const isUser = filled(cells[iUser])
    const isNonUser = filled(cells[iNonUser])
    if (isUser === isNonUser) continue // answered both blocks or neither: unusable
    records.push({
      ori,
      status: isUser ? 'yes' : 'no',
      declineReasons: isUser
        ? []
        : reasonCols.filter(([at]) => String(cells[at] || '').trim() === '1').map(([, label]) => label),
    })
  }

  const stats = { rows: records.length, yes: 0, no: 0, matched: 0, wrote: 0, keptObserved: 0 }
  stats.yes = records.filter((r) => r.status === 'yes').length
  stats.no = records.filter((r) => r.status === 'no').length

  const existing = new Map(
    (await LeAgency.find({ ori: { $in: records.map((r) => r.ori) } })
      .select('ori surveillance.bwc.status surveillance.bwc.evidence')
      .lean()).map((a) => [a.ori, a]),
  )
  stats.matched = existing.size

  const importedAt = new Date()
  const operations = []
  for (const record of records) {
    const current = existing.get(record.ori)
    if (!current) continue
    // A sighting outranks a nine-year-old survey answer, in both directions:
    // it is newer, and it is an observation rather than a self-report.
    if (current.surveillance?.bwc?.evidence === 'observed') {
      stats.keptObserved += 1
      continue
    }
    operations.push({
      updateOne: {
        filter: { ori: record.ori },
        update: {
          $set: {
            'surveillance.bwc.status': record.status,
            'surveillance.bwc.hasBwc': record.status === 'yes',
            'surveillance.bwc.evidence': 'surveyed',
            'surveillance.bwc.asOf': AS_OF,
            'surveillance.bwc.declineReasons': record.declineReasons,
            'surveillance.bwc.source': SOURCE_NAME,
            'surveillance.bwc.importedAt': importedAt,
          },
          $addToSet: {
            provenance: { source: SOURCE_NAME, url: SOURCE_URL, retrievedAt: importedAt },
          },
        },
      },
    })
  }

  console.log(`LEMAS-BWCS 2016: ${stats.rows} usable rows (${stats.yes} yes, ${stats.no} no)`)
  console.log(`  matched to our agencies : ${stats.matched}`)
  console.log(`  already observed, kept  : ${stats.keptObserved}`)
  console.log(`  to write                : ${operations.length}`)

  if (args['dry-run']) {
    console.log('  (dry run - nothing written)')
    await mongoose.disconnect()
    return
  }

  for (let i = 0; i < operations.length; i += 1000) {
    const result = await LeAgency.bulkWrite(operations.slice(i, i + 1000), { ordered: false })
    stats.wrote += result.modifiedCount
  }
  console.log(`  written                 : ${stats.wrote}`)

  const summary = await LeAgency.aggregate([
    { $match: { 'surveillance.bwc.status': { $in: ['yes', 'no'] } } },
    { $group: { _id: { status: '$surveillance.bwc.status', evidence: '$surveillance.bwc.evidence' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ])
  console.log('\nCamera layer now:')
  for (const row of summary) {
    console.log(`  ${row._id.status.padEnd(4)} / ${String(row._id.evidence).padEnd(9)} ${row.n}`)
  }

  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
