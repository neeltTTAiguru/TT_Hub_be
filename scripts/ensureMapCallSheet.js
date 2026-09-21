import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { MAP_CALL_SHEET_VIEW, ensureMapCallSheet } from '../src/services/mapCallSheet.js'

dotenv.config()

/**
 * Create or refresh the `map_calls` view by hand and show what it holds.
 *
 * The server does this on every boot; this is for checking a database the
 * server is not pointed at, or seeing the rep-by-day totals without an API.
 */
const run = async () => {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!mongoUri) throw new Error('MONGODB_URI is not set.')
  await mongoose.connect(mongoUri)
  try {
    const result = await ensureMapCallSheet()
    console.log(`${result.view}: ${result.action}`)
    const view = mongoose.connection.db.collection(MAP_CALL_SHEET_VIEW)
    console.log(`rows: ${await view.countDocuments()}`)
    const byRepAndDay = await view
      .aggregate([
        { $match: { kind: 'call' } },
        { $group: { _id: { rep: '$loggedBy', day: '$calledOn' }, calls: { $sum: 1 } } },
        { $sort: { '_id.day': -1, '_id.rep': 1 } },
        { $limit: 20 },
      ])
      .toArray()
    for (const row of byRepAndDay) console.log(row._id.day, row._id.rep, row.calls)
  } finally {
    await mongoose.disconnect()
  }
}

run().catch((error) => {
  console.error(error?.message || error)
  process.exitCode = 1
})
