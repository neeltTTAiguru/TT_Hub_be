/**
 * One-off: moves the body-worn camera layer from a bare boolean onto the
 * status/evidence/asOf shape.
 *
 * The boolean could only ever mean "someone saw a camera". Once LEMAS is in,
 * an agency can also have told a federal surveyor it has none - and a state
 * can require cameras by law, which is a duty rather than a sighting. Those
 * are different claims with different shelf lives, and flattening them back
 * into one true/false throws away the only thing that makes a negative safe
 * to act on.
 *
 * Every existing record came from the Atlas, so all of them become
 * status 'yes' / evidence 'observed', dated to the evidence they carry.
 *
 * Usage:
 *   node scripts/migrateBwcEvidence.js --dry-run
 *   node scripts/migrateBwcEvidence.js
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'

dotenv.config()

const dryRun = process.argv.includes('--dry-run')

const run = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) throw new Error('MONGODB_URI is not set.')
  await mongoose.connect(uri)

  const pending = await LeAgency.find({
    'surveillance.bwc.hasBwc': true,
    $or: [{ 'surveillance.bwc.status': { $exists: false } }, { 'surveillance.bwc.status': 'unknown' }],
  })
    .select('ori surveillance.bwc')
    .lean()

  console.log(`Atlas records to migrate: ${pending.length}`)
  if (dryRun) {
    for (const agency of pending.slice(0, 5)) {
      const bwc = agency.surveillance.bwc
      console.log(
        `  ${agency.ori}  status=yes evidence=observed asOf=${
          bwc.evidenceDate ? new Date(bwc.evidenceDate).toISOString().slice(0, 10) : 'null'
        }`,
      )
    }
    console.log('  (dry run - nothing written)')
    await mongoose.disconnect()
    return
  }

  const operations = pending.map((agency) => ({
    updateOne: {
      filter: { ori: agency.ori },
      update: {
        $set: {
          'surveillance.bwc.status': 'yes',
          'surveillance.bwc.evidence': 'observed',
          // The sighting's own date where the Atlas published one. Left null
          // rather than back-filled with the import date, which would claim a
          // freshness the evidence does not have.
          'surveillance.bwc.asOf': agency.surveillance.bwc.evidenceDate || null,
        },
      },
    },
  }))

  let written = 0
  for (let i = 0; i < operations.length; i += 1000) {
    const result = await LeAgency.bulkWrite(operations.slice(i, i + 1000), { ordered: false })
    written += result.modifiedCount
  }
  console.log(`Migrated ${written} records to status/evidence/asOf.`)

  const byEvidence = await LeAgency.aggregate([
    { $match: { 'surveillance.bwc.status': { $in: ['yes', 'no'] } } },
    { $group: { _id: { status: '$surveillance.bwc.status', evidence: '$surveillance.bwc.evidence' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ])
  for (const row of byEvidence) {
    console.log(`  ${row._id.status.padEnd(4)} / ${String(row._id.evidence).padEnd(9)} ${row.n}`)
  }

  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
