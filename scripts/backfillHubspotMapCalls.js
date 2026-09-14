import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'
import { backfillMapCalls } from '../src/services/hubspotMapCalls.js'

dotenv.config()

const run = async () => {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!mongoUri) throw new Error('MONGODB_URI is not set.')
  if (!process.env.HUBSPOT_API_TOKEN && !process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
    throw new Error('HUBSPOT_API_TOKEN is not set.')
  }

  await mongoose.connect(mongoUri)
  try {
    const agencies = LeAgency.find({ 'callLog.0': { $exists: true } })
      .select('ori agencyName crm.hubspotCompanyId crm.hubspotContactId callLog')
      .cursor()
    const stats = await backfillMapCalls(agencies)
    console.log(JSON.stringify(stats))
    if (stats.failed) process.exitCode = 2
  } finally {
    await mongoose.disconnect()
  }
}

run().catch((error) => {
  console.error(error?.message || error)
  process.exitCode = 1
})
