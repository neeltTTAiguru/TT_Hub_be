/**
 * Fills in who currently leads each agency - the chief or sheriff, and their
 * command staff.
 *
 * Unlike the location work, no public dataset carries this, so every record
 * costs a handful of web searches. Scope every run: start with sheriffs in one
 * state, check the results by hand, and widen only once you trust them.
 *
 * Names are only written when the model cited a URL for them. An agency that
 * comes back empty is stamped as checked so a resumed run does not pay for it
 * twice, and so a later re-verification pass can find the stalest records.
 *
 * Usage:
 *   node scripts/enrichAgencyLeadership.js --state=TX --type=County --dry-run --limit=5
 *   node scripts/enrichAgencyLeadership.js --state=TX --type=County
 *   node scripts/enrichAgencyLeadership.js --state=TX --stale   # re-verify oldest first
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'
import { researchLeadership, saveLeadership, isFresh } from '../src/services/agencyLeadership.js'

dotenv.config()

const parseArgs = () => {
  const out = {}
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw)
    if (m) out[m[1]] = m[2] === undefined ? 'true' : m[2]
  }
  return out
}
const args = parseArgs()
const dryRun = args['dry-run'] === 'true'
const limit = args.limit ? Number(args.limit) : Infinity
// Each request runs several web searches, so the ceiling here is the API's
// tolerance rather than ours. Three at a time has been comfortable.
const concurrency = Math.max(1, Number(args.concurrency || 3))
const stale = args.stale === 'true'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const buildSelector = () => {
  const selector = {}
  if (args.state) selector.state = String(args.state).toUpperCase()
  if (args.type) selector.agencyType = String(args.type)
  if (args.ori) selector.ori = String(args.ori).toUpperCase()
  if (args.only === 'pipeline') selector['crm.matched'] = true
  if (args['min-officers']) {
    selector['employment.swornOfficers'] = { $gte: Number(args['min-officers']) }
  }
  // Default to agencies never looked at; --stale revisits the oldest instead.
  if (!stale) selector['enrichment.leadershipCheckedAt'] = null
  return selector
}

const stats = { ok: 0, notFound: 0, failed: 0, retryable: 0, searches: 0, staff: 0 }

const runPool = async (items, worker) => {
  let cursor = 0
  const run = async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
}

const main = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set')
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set')
  if (!args.state && !args.ori && args.all !== 'true') {
    throw new Error('Refusing to run unscoped. Pass --state=XX, --ori=..., or --all=true.')
  }

  await mongoose.connect(process.env.MONGODB_URI)

  const pending = (
    await LeAgency.find(buildSelector())
      .select('ori agencyName agencyType state stateName county contacts enrichment employment.swornOfficers')
      .sort(stale ? { 'enrichment.leadershipCheckedAt': 1 } : { 'employment.swornOfficers': -1 })
      .limit(Number.isFinite(limit) ? limit : 0)
      .lean()
  ).filter((agency) => stale || !isFresh(agency))

  console.log(`\nLeadership lookup: ${pending.length} agencies`)
  if (!pending.length) {
    await mongoose.disconnect()
    return
  }
  if (dryRun) console.log('(dry run - nothing will be written)\n')

  let done = 0
  await runPool(pending, async (agency) => {
    let result
    try {
      result = await researchLeadership(agency)
    } catch (error) {
      stats.failed += 1
      // A rate limit, a 5xx or a timeout says nothing about the agency, so it
      // must NOT be stamped as checked - the default selector only picks up
      // records where leadershipCheckedAt is null, so stamping one here would
      // retire it permanently on the strength of a transient blip. Leave it
      // untouched and the next resumed run picks it up again.
      const status = error?.statusCode
      const transient = status === 429 || status === 408 || status >= 500 || status === undefined
      if (transient) stats.retryable += 1
      console.warn(
        `  ! ${agency.agencyName}: ${String(error.message).slice(0, 100)}` +
          `${transient ? ' [transient - will retry on next run]' : ''}`,
      )
      if (!dryRun && !transient) {
        await LeAgency.updateOne(
          { ori: agency.ori },
          { $set: { 'enrichment.leadershipStatus': 'failed', 'enrichment.leadershipCheckedAt': new Date() } },
        )
      }
      return
    }

    stats.searches += result.searches || 0
    if (result.status === 'ok') {
      stats.ok += 1
      stats.staff += result.commandStaff.length
      console.log(
        `  ${agency.agencyName.slice(0, 32).padEnd(34)} ${`${result.chiefTitle} ${result.chiefName}`.trim().slice(0, 38).padEnd(40)}` +
          `${result.commandStaff.length ? `+${result.commandStaff.length} staff ` : ''}${result.chiefSourceUrl.slice(0, 44)}`,
      )
    } else {
      stats.notFound += 1
      console.log(`  ${agency.agencyName.slice(0, 32).padEnd(34)} (nothing citable found)`)
    }

    if (!dryRun) await saveLeadership(agency.ori, result)

    done += 1
    if (done % 25 === 0) console.log(`  ...${done}/${pending.length}`)
    // Gentle spacing; the searches themselves dominate the wall clock.
    await sleep(200)
  })

  console.log('\nSummary')
  console.log(`  chief found       ${stats.ok}`)
  console.log(`  command staff     ${stats.staff}`)
  console.log(`  nothing citable   ${stats.notFound}`)
  console.log(`  failed            ${stats.failed}`)
  console.log(`  of which retryable ${stats.retryable} (left unstamped, picked up next run)`)
  console.log(`  web searches run  ${stats.searches}`)
  if (dryRun) console.log('  (dry run - nothing written)')

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
