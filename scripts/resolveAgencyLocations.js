/**
 * Second pass over the agencies the crosswalk import could not place.
 *
 * After importLeaicAddresses.js, ~5,800 agencies are still pinned to their
 * county centre. They fall into two groups, and this script handles both:
 *
 *   retry     ~800 have a real street address that the geocoder rejected,
 *             because the crosswalk appends suites and building names
 *             ("101 COURT SQ STE G", "300 WASHINGTON ST COURTHOUSE").
 *             Normalising the line and resubmitting recovers most of them
 *             at rooftop or street precision.
 *
 *   centroid  ~5,000 list only a PO box, so no street exists to geocode.
 *             Every one still has a city and most have a ZIP, so the Census
 *             Gazetteer centroid puts them in the correct town. That is not
 *             a real location and is stored as precision 'city' so the map
 *             keeps drawing them as approximate - but a pin in the right
 *             town beats one at the centre of the county.
 *
 * Run retry first: a street match beats a centroid, and the centroid phase
 * would otherwise mark those agencies resolved and skip them.
 *
 * Usage:
 *   node scripts/resolveAgencyLocations.js --phase=retry --dry-run
 *   node scripts/resolveAgencyLocations.js --phase=centroid
 *   node scripts/resolveAgencyLocations.js --phase=all
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'
import { geocodeBatch, normalizeStreet } from '../src/services/censusGeocoder.js'

dotenv.config()

const GAZETTEER_YEAR = '2024'
const GAZETTEER_BASE = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${GAZETTEER_YEAR}_Gazetteer`
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'gazetteer')

const parseArgs = () => {
  const out = {}
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw)
    if (m) out[m[1]] = m[2] === undefined ? 'true' : m[2]
  }
  return out
}
const args = parseArgs()
const phase = args.phase || 'all'
const dryRun = args['dry-run'] === 'true'
const limit = args.limit ? Number(args.limit) : Infinity
const batchSize = Math.min(Number(args['batch-size'] || 2000), 10000)

const has = { $exists: true, $nin: ['', null] }

/** Agencies still sitting on a county centre, or with no coordinate at all. */
const unresolved = () => {
  const selector = { 'location.resolvedAt': null }
  if (args.state) selector.state = String(args.state).toUpperCase()
  if (args.ori) selector.ori = String(args.ori).toUpperCase()
  return selector
}

const setLocation = (agency, { lat, lon, precision, geocoder, matchedAddress, status }) => ({
  updateOne: {
    filter: { ori: agency.ori },
    update: {
      $set: {
        location: {
          latitude: lat,
          longitude: lon,
          geo: { type: 'Point', coordinates: [lon, lat] },
          precision,
          geocoder,
          matchedAddress,
          resolvedAt: new Date(),
        },
        'enrichment.locationStatus': status || 'ok',
        'enrichment.locationAttemptedAt': new Date(),
      },
    },
  },
})

// --- phase: retry ----------------------------------------------------------

const runRetryPhase = async () => {
  const pending = await LeAgency.find({
    ...unresolved(),
    'contacts.streetAddress.line1': has,
  })
    .select('ori agencyName state contacts.streetAddress')
    .limit(Number.isFinite(limit) ? limit : 0)
    .lean()

  console.log(`\nPhase - retry (${pending.length} with an unmatched street address)`)
  if (!pending.length) return

  const rows = []
  let buildingNames = 0
  for (const agency of pending) {
    const address = agency.contacts.streetAddress
    const street = normalizeStreet(address.line1)
    if (!street) {
      buildingNames += 1
      continue
    }
    rows.push({
      agency,
      row: {
        id: agency.ori,
        street,
        city: address.city,
        state: address.state || agency.state,
        zip: address.zip,
      },
      // Only worth a request if cleaning actually changed something.
      changed: street !== String(address.line1).toUpperCase().replace(/\s+/g, ' ').trim(),
    })
  }

  console.log(`  building names, no house number  ${buildingNames} (skipped)`)
  console.log(`  submitting                       ${rows.length}`)

  const stats = { ok: 0, rooftop: 0, noMatch: 0, tie: 0 }
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize)
    let results
    try {
      results = await geocodeBatch(slice.map((r) => r.row))
    } catch (error) {
      console.warn(`  ! batch failed: ${error.message}`)
      continue
    }

    const operations = []
    for (const { agency, row } of slice) {
      const result = results.get(agency.ori) || { status: 'no-match' }
      if (result.status !== 'ok') {
        if (result.status === 'tie') stats.tie += 1
        else stats.noMatch += 1
        continue
      }
      stats.ok += 1
      if (result.precision === 'rooftop') stats.rooftop += 1
      if (dryRun) {
        console.log(
          `  ${agency.agencyName.slice(0, 30).padEnd(32)} "${row.street}" -> ` +
            `${result.lat.toFixed(5)},${result.lon.toFixed(5)} (${result.precision})`,
        )
        continue
      }
      operations.push(
        setLocation(agency, {
          lat: result.lat,
          lon: result.lon,
          precision: result.precision,
          geocoder: 'census',
          matchedAddress: result.matchedAddress,
        }),
      )
    }
    if (operations.length) await LeAgency.bulkWrite(operations, { ordered: false })
  }

  console.log(`  recovered                        ${stats.ok} (${stats.rooftop} rooftop)`)
  console.log(`  still no match                   ${stats.noMatch}`)
  console.log(`  ambiguous                        ${stats.tie}`)
  if (dryRun) console.log('  (dry run - nothing written)')
}

// --- phase: centroid -------------------------------------------------------

/** Downloads a Gazetteer file once and caches it; they are static per year. */
const fetchGazetteer = async (name) => {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const cached = path.join(CACHE_DIR, `${GAZETTEER_YEAR}_${name}.txt`)
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'latin1')

  const url = `${GAZETTEER_BASE}/${GAZETTEER_YEAR}_Gaz_${name}_national.zip`
  console.log(`  downloading ${name} gazetteer...`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Gazetteer ${name} returned ${response.status}`)

  // Single-entry zip; read the local file header to find the payload rather
  // than shelling out to unzip.
  const buffer = Buffer.from(await response.arrayBuffer())
  const nameLength = buffer.readUInt16LE(26)
  const extraLength = buffer.readUInt16LE(28)
  const start = 30 + nameLength + extraLength
  const text = zlib.inflateRawSync(buffer.subarray(start)).toString('latin1')

  fs.writeFileSync(cached, text)
  return text
}

/** Gazetteer files are tab separated with padded headers. */
const parseGazetteer = (text) => {
  const lines = text.split('\n').filter((l) => l.trim())
  const header = lines[0].split('\t').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const parts = line.split('\t')
    const row = {}
    header.forEach((key, index) => {
      row[key] = String(parts[index] ?? '').trim()
    })
    return row
  })
}

/** "Willow Park city" -> "WILLOW PARK", so it matches the crosswalk's city. */
const placeKey = (state, name) =>
  `${state}|${String(name)
    .toUpperCase()
    .replace(
      /\s+(CITY AND BOROUGH|CONSOLIDATED GOVERNMENT|METRO(POLITAN)? GOVERNMENT|CITY|TOWN|VILLAGE|BOROUGH|TOWNSHIP|MUNICIPALITY|CDP|COMDEV DISTRICT)$/,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()}`

const runCentroidPhase = async () => {
  console.log('\nPhase - centroid (Census Gazetteer)')

  const [zctaRows, placeRows] = await Promise.all([
    fetchGazetteer('zcta').then(parseGazetteer),
    fetchGazetteer('place').then(parseGazetteer),
  ])

  const byZip = new Map()
  for (const row of zctaRows) {
    const zip = String(row.GEOID || '').padStart(5, '0')
    const lat = Number(row.INTPTLAT)
    const lon = Number(row.INTPTLONG)
    if (zip && Number.isFinite(lat) && Number.isFinite(lon)) byZip.set(zip, { lat, lon })
  }

  const byPlace = new Map()
  for (const row of placeRows) {
    const lat = Number(row.INTPTLAT)
    const lon = Number(row.INTPTLONG)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const key = placeKey(row.USPS, row.NAME)
    // Several places can share a name in one state; first wins, and the
    // ambiguity only costs precision we are not claiming anyway.
    if (!byPlace.has(key)) byPlace.set(key, { lat, lon })
  }
  console.log(`  ${byZip.size} ZIP centroids, ${byPlace.size} place centroids`)

  const pending = await LeAgency.find({
    ...unresolved(),
    'contacts.streetAddress.city': has,
    // Only agencies with nothing better. A genuine FBI coordinate is worth
    // more than a town centroid, so it must never be superseded by one.
    $or: [{ fbiCoordIsCountyProxy: true }, { latitude: null }],
  })
    .select('ori agencyName state contacts.streetAddress')
    .limit(Number.isFinite(limit) ? limit : 0)
    .lean()

  console.log(`  ${pending.length} agencies to place`)

  const stats = { zip: 0, place: 0, miss: 0 }
  const operations = []
  for (const agency of pending) {
    const address = agency.contacts.streetAddress
    const zip = String(address.zip || '').slice(0, 5).padStart(5, '0')
    const state = address.state || agency.state

    let hit = zip && byZip.get(zip)
    let matched = hit ? `ZIP ${zip}` : ''
    if (hit) stats.zip += 1

    if (!hit && address.city) {
      hit = byPlace.get(placeKey(state, address.city))
      if (hit) {
        matched = `${address.city}, ${state}`
        stats.place += 1
      }
    }

    if (!hit) {
      stats.miss += 1
      continue
    }

    if (dryRun) {
      console.log(`  ${agency.agencyName.slice(0, 32).padEnd(34)} -> ${matched}`)
      continue
    }

    operations.push(
      setLocation(agency, {
        lat: hit.lat,
        lon: hit.lon,
        precision: 'city',
        geocoder: 'census_gazetteer',
        matchedAddress: matched,
      }),
    )
  }

  if (operations.length) {
    for (let i = 0; i < operations.length; i += 1000) {
      await LeAgency.bulkWrite(operations.slice(i, i + 1000), { ordered: false })
    }
  }

  console.log(`  placed by ZIP centroid           ${stats.zip}`)
  console.log(`  placed by city centroid          ${stats.place}`)
  console.log(`  no centroid found                ${stats.miss}`)
  if (dryRun) console.log('  (dry run - nothing written)')
}

// --- main ------------------------------------------------------------------

const main = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set')
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB')

  if (phase === 'retry' || phase === 'all') await runRetryPhase()
  if (phase === 'centroid' || phase === 'all') await runCentroidPhase()

  const counts = {}
  for (const precision of ['rooftop', 'street', 'city']) {
    counts[precision] = await LeAgency.countDocuments({ 'location.precision': precision })
  }
  const stranded = await LeAgency.countDocuments({
    'location.resolvedAt': null,
    fbiCoordIsCountyProxy: true,
  })

  console.log('\nDatabase totals')
  console.log(`  rooftop                 ${counts.rooftop}`)
  console.log(`  street level            ${counts.street}`)
  console.log(`  town centre only        ${counts.city}`)
  console.log(`  still on a county centre ${stranded}`)

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
