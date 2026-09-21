import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'
import { BOOKMARK_OUTCOME } from '../src/services/hubspotMapCalls.js'
import { call, ensureEnumerationOption } from '../src/services/hubspotRest.js'

dotenv.config()

/**
 * The "Call later" bookmarks that were synced to HubSpot as completed calls
 * before the map learned not to send them.
 *
 * Default: retag them (`Call source` = "Agency Map bookmark") so a report on
 * `Call source = Agency Map` no longer counts them, and nothing is lost.
 * `--delete` removes them from HubSpot instead; the hub's log keeps them
 * either way. `--dry-run` only counts.
 */
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const remove = args.has('--delete')

const run = async () => {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!mongoUri) throw new Error('MONGODB_URI is not set.')
  await mongoose.connect(mongoUri)
  try {
    const agencies = LeAgency.find({ callLog: { $elemMatch: { outcome: BOOKMARK_OUTCOME, hubspotCallId: { $nin: ['', null] } } } })
      .select('ori callLog')
      .cursor()
    if (!dryRun && !remove) {
      await ensureEnumerationOption('calls', 'tt_call_source', {
        label: 'Agency Map bookmark',
        value: 'agency_map_bookmark',
        hidden: false,
      })
    }
    const stats = { found: 0, done: 0, failed: 0 }
    for await (const agency of agencies) {
      for (const entry of agency.callLog) {
        if (entry.outcome !== BOOKMARK_OUTCOME || !entry.hubspotCallId) continue
        stats.found += 1
        if (dryRun) continue
        try {
          if (remove) {
            await call('DELETE', `/crm/v3/objects/calls/${entry.hubspotCallId}`)
            entry.hubspotCallId = ''
            entry.hubspotSyncedAt = null
          } else {
            await call('PATCH', `/crm/v3/objects/calls/${entry.hubspotCallId}`, {
              properties: { tt_call_source: 'agency_map_bookmark', hs_call_title: `Map Bookmark - ${agency.ori}` },
            })
          }
          entry.hubspotSyncError = ''
          stats.done += 1
        } catch (error) {
          entry.hubspotSyncError = String(error?.message || error).slice(0, 300)
          stats.failed += 1
        }
      }
      if (!dryRun) await agency.save()
    }
    console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : remove ? 'delete' : 'retag', ...stats }))
    if (stats.failed) process.exitCode = 2
  } finally {
    await mongoose.disconnect()
  }
}

run().catch((error) => {
  console.error(error?.message || error)
  process.exitCode = 1
})
