/**
 * Puts real street addresses and real coordinates onto the agency map.
 *
 * The FBI Crime Data Explorer feed carries no address, and where it has no
 * genuine coordinate it silently substitutes the Census *county* internal
 * point - 8,771 of our 16,947 mapped agencies sit on one, which is why e.g.
 * Willow Park PD plots nine miles away, next to Weatherford.
 *
 * The DOJ Law Enforcement Agency Identifiers Crosswalk (ICPSR 35158) is the
 * only public file that is keyed on ORI *and* carries a street address, so it
 * closes the gap without a single web search. It also carries the county
 * internal point itself, which is what lets us prove which FBI coordinates are
 * fake rather than guessing from duplicates.
 *
 * Two phases, both resumable and independently runnable:
 *   addresses  join the crosswalk on ORI9, write contacts.streetAddress and
 *              flag the FBI coordinates that are county proxies
 *   geocode    push those addresses through the Census geocoder (free, no key)
 *              and write the result to `location`, never over the FBI pair
 *
 * Get the file from https://www.icpsr.umich.edu/web/NACJD/studies/35158
 * (free account, choose the "Delimited" download).
 *
 * Usage:
 *   node scripts/importLeaicAddresses.js --phase=addresses --file=/path/35158-0001-Data.tsv --dry-run
 *   node scripts/importLeaicAddresses.js --phase=geocode --only=pipeline
 *   node scripts/importLeaicAddresses.js --phase=all --file=... --state=TX
 */
import fs from 'node:fs'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'

dotenv.config()

const SOURCE_NAME = 'leaic_2012'
const SOURCE_YEAR = 2012
const SOURCE_URL = 'https://doi.org/10.3886/ICPSR35158.v2'
const GEOCODER = 'census'
const BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'
// The Census batch endpoint documents a 10,000-record ceiling per submission.
// Smaller batches come back faster and lose less work when one 500s.
const BATCH_LIMIT = 2000

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
const refresh = args.refresh === 'true'
const limit = args.limit ? Number(args.limit) : Infinity
const batchSize = Math.min(Number(args['batch-size'] || BATCH_LIMIT), 10000)

const clean = (value) => String(value ?? '').trim().replace(/^"|"$/g, '')

/** LEAIC writes a literal '.' or '-1' where a value is absent. */
const value = (raw) => {
  const text = clean(raw)
  return text === '.' || text === '-1' ? '' : text
}

// A PO box geocodes to the post office, not the station, so it is worse than
// no street at all - it produces a confident pin in the wrong place.
// No \b after BOX: the crosswalk writes "P.O. BOX10" without a space, which a
// word boundary would let through. Drawers are the same thing under another name.
const isPoBox = (line) =>
  /^\s*P\.?\s*O\.?\s*(BOX|DRAWER)/i.test(line) ||
  /^\s*POST\s+OFFICE\s+(BOX|DRAWER)/i.test(line) ||
  /^\s*(BOX|DRAWER)\s*\d/i.test(line)

/** Selector shared by both phases, so a dry run and a real run see one set. */
const buildSelector = () => {
  const selector = {}
  if (args.only === 'pipeline') selector['crm.matched'] = true
  if (args.state) selector.state = String(args.state).toUpperCase()
  if (args.county) selector.county = new RegExp(String(args.county), 'i')
  if (args.ori) selector.ori = String(args.ori).toUpperCase()
  return selector
}

// --- phase: addresses ------------------------------------------------------

const readCrosswalk = (file) => {
  const lines = fs.readFileSync(file, 'latin1').split('\n')
  const header = lines[0].split('\t').map(clean)
  const at = (name) => {
    const index = header.indexOf(name)
    if (index < 0) throw new Error(`Crosswalk is missing the "${name}" column`)
    return index
  }
  const cols = {
    ori9: at('ORI9'),
    name: at('NAME'),
    str1: at('ADDRESS_STR1'),
    str2: at('ADDRESS_STR2'),
    city: at('ADDRESS_CITY'),
    state: at('ADDRESS_STATE'),
    zip: at('ADDRESS_ZIP'),
    lat: at('INTPTLAT'),
    lon: at('INTPTLONG'),
  }

  const byOri = new Map()
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const row = line.split('\t')
    const ori = value(row[cols.ori9]).toUpperCase()
    if (!ori) continue
    // Later duplicates are the same agency re-listed; the first wins.
    if (!byOri.has(ori)) byOri.set(ori, row)
  }
  return { byOri, cols }
}

const runAddressPhase = async () => {
  const file = args.file
  if (!file) throw new Error('Pass --file=/path/to/35158-0001-Data.tsv')

  const { byOri, cols } = readCrosswalk(file)
  console.log(`\nPhase 1 - addresses (${byOri.size} ORI-keyed crosswalk rows)`)

  const agencies = await LeAgency.find(buildSelector())
    .select('ori agencyName state county latitude longitude')
    .limit(Number.isFinite(limit) ? limit : 0)
    .lean()

  const stats = { linked: 0, street: 0, poBox: 0, cityOnly: 0, proxy: 0, missing: 0 }
  const operations = []

  for (const agency of agencies) {
    const row = byOri.get(agency.ori)
    if (!row) {
      stats.missing += 1
      continue
    }
    stats.linked += 1

    const line1 = value(row[cols.str1])
    const city = value(row[cols.city])
    const usableStreet = line1 && !isPoBox(line1)

    if (usableStreet) stats.street += 1
    else if (line1) stats.poBox += 1
    else if (city) stats.cityOnly += 1

    // The crosswalk's internal point is the county's. Where the FBI pair is
    // exactly that, the FBI had no real location for this agency.
    const countyLat = Number(value(row[cols.lat]))
    const countyLon = Number(value(row[cols.lon]))
    const isProxy =
      Number.isFinite(agency.latitude) &&
      Number.isFinite(countyLat) &&
      Math.abs(agency.latitude - countyLat) < 0.0001 &&
      Math.abs(agency.longitude - countyLon) < 0.0001
    if (isProxy) stats.proxy += 1

    if (dryRun) {
      console.log(
        `  ${agency.ori} ${agency.agencyName.slice(0, 32).padEnd(32)} ` +
          `${(usableStreet ? line1 : line1 ? `[PO box] ${line1}` : '(no street)').slice(0, 32).padEnd(32)} ` +
          `${city.padEnd(16)} ${isProxy ? 'FBI=county proxy' : ''}`,
      )
      continue
    }

    operations.push({
      updateOne: {
        filter: { ori: agency.ori },
        update: {
          $set: {
            fbiCoordIsCountyProxy: isProxy,
            'contacts.streetAddress': {
              line1: usableStreet ? line1 : '',
              line2: usableStreet ? value(row[cols.str2]) : '',
              city,
              state: value(row[cols.state]),
              zip: value(row[cols.zip]),
              source: SOURCE_NAME,
              sourceYear: SOURCE_YEAR,
            },
          },
          $addToSet: {
            provenance: { source: SOURCE_NAME, url: SOURCE_URL, retrievedAt: new Date() },
          },
        },
      },
    })
  }

  if (operations.length) {
    for (let i = 0; i < operations.length; i += 1000) {
      await LeAgency.bulkWrite(operations.slice(i, i + 1000), { ordered: false })
    }
  }

  console.log(`  considered            ${agencies.length}`)
  console.log(`  linked by ORI9        ${stats.linked}`)
  console.log(`  usable street address ${stats.street}`)
  console.log(`  PO box only           ${stats.poBox}`)
  console.log(`  city but no street    ${stats.cityOnly}`)
  console.log(`  FBI coord is a county proxy  ${stats.proxy}`)
  console.log(`  not in the crosswalk  ${stats.missing}`)
  if (dryRun) console.log('  (dry run - nothing written)')
}

// --- phase: geocode --------------------------------------------------------

/** One CSV row per address, in the column order the batch endpoint expects. */
const toBatchRow = (agency) => {
  const address = agency.contacts?.streetAddress || {}
  const escape = (text) => `"${String(text || '').replace(/"/g, '')}"`
  return [
    escape(agency.ori),
    escape(address.line1),
    escape(address.city),
    escape(address.state || agency.state),
    escape(address.zip),
  ].join(',')
}

/**
 * Splits a Census response line on commas outside quotes. The matched-address
 * field contains commas of its own, so a plain split corrupts every row.
 */
const splitCsvLine = (line) => {
  const fields = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ',' && !inQuotes) {
      fields.push(field)
      field = ''
    } else field += ch
  }
  fields.push(field)
  return fields
}

const geocodeBatch = async (agencies) => {
  const csv = agencies.map(toBatchRow).join('\n')
  const form = new FormData()
  form.append('benchmark', 'Public_AR_Current')
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv')

  const response = await fetch(BATCH_URL, { method: 'POST', body: form })
  if (!response.ok) throw new Error(`Census geocoder returned ${response.status}`)

  const results = new Map()
  for (const line of (await response.text()).split('\n')) {
    if (!line.trim()) continue
    const fields = splitCsvLine(line)
    const [ori, , indicator, matchType, matchedAddress, coordinates] = fields.map((f) =>
      f.replace(/^"|"$/g, '').trim(),
    )
    if (indicator !== 'Match') {
      results.set(ori, { status: indicator === 'Tie' ? 'tie' : 'no-match' })
      continue
    }
    const [lon, lat] = String(coordinates).split(',').map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      results.set(ori, { status: 'no-match' })
      continue
    }
    results.set(ori, {
      status: 'ok',
      lat,
      lon,
      matchedAddress,
      // The Census 'Exact' flag means the street number itself matched, which
      // is as close to a rooftop as this geocoder gets.
      precision: matchType === 'Exact' ? 'rooftop' : 'street',
    })
  }
  return results
}

const runGeocodePhase = async () => {
  const selector = {
    ...buildSelector(),
    // $ne alone also matches documents where the field is absent, which would
    // hand the geocoder every agency in the collection.
    'contacts.streetAddress.line1': { $exists: true, $nin: ['', null] },
  }
  if (!refresh) selector['location.resolvedAt'] = null

  const pending = await LeAgency.find(selector)
    .select('ori agencyName state contacts.streetAddress latitude longitude')
    .limit(Number.isFinite(limit) ? limit : 0)
    .lean()

  console.log(`\nPhase 2 - geocode (${pending.length} agencies with a street address)`)
  if (!pending.length) return

  const stats = { ok: 0, rooftop: 0, noMatch: 0, tie: 0, moved: 0 }

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    let results
    try {
      results = await geocodeBatch(batch)
    } catch (error) {
      console.warn(`  ! batch ${i / batchSize + 1} failed: ${error.message}`)
      continue
    }

    const operations = []
    for (const agency of batch) {
      const result = results.get(agency.ori) || { status: 'failed' }

      if (result.status !== 'ok') {
        if (result.status === 'tie') stats.tie += 1
        else stats.noMatch += 1
        if (!dryRun) {
          operations.push({
            updateOne: {
              filter: { ori: agency.ori },
              update: {
                $set: {
                  'enrichment.locationStatus': result.status,
                  'enrichment.locationAttemptedAt': new Date(),
                },
              },
            },
          })
        }
        continue
      }

      stats.ok += 1
      if (result.precision === 'rooftop') stats.rooftop += 1
      // How far the pin moves is the headline number: it is the error the FBI
      // feed was carrying for this agency.
      const movedMiles =
        Number.isFinite(agency.latitude) && Number.isFinite(agency.longitude)
          ? haversineMiles(agency.latitude, agency.longitude, result.lat, result.lon)
          : null
      if (movedMiles !== null && movedMiles > 1) stats.moved += 1

      if (dryRun) {
        console.log(
          `  ${agency.ori} ${agency.agencyName.slice(0, 34).padEnd(34)} ` +
            `${result.lat.toFixed(5)},${result.lon.toFixed(5)} ` +
            `${result.precision.padEnd(7)} ` +
            `${movedMiles === null ? '' : `moved ${movedMiles.toFixed(1)} mi`}`,
        )
        continue
      }

      operations.push({
        updateOne: {
          filter: { ori: agency.ori },
          update: {
            $set: {
              location: {
                latitude: result.lat,
                longitude: result.lon,
                geo: { type: 'Point', coordinates: [result.lon, result.lat] },
                precision: result.precision,
                geocoder: GEOCODER,
                matchedAddress: result.matchedAddress,
                resolvedAt: new Date(),
              },
              'enrichment.locationStatus': 'ok',
              'enrichment.locationAttemptedAt': new Date(),
            },
          },
        },
      })
    }

    if (operations.length) await LeAgency.bulkWrite(operations, { ordered: false })
    if (!dryRun) console.log(`  ...${Math.min(i + batchSize, pending.length)}/${pending.length}`)
  }

  console.log(`\n  geocoded              ${stats.ok}`)
  console.log(`    rooftop             ${stats.rooftop}`)
  console.log(`    street level        ${stats.ok - stats.rooftop}`)
  console.log(`  no match              ${stats.noMatch}`)
  console.log(`  ambiguous (tie)       ${stats.tie}`)
  console.log(`  pin moved over a mile ${stats.moved}`)
  if (dryRun) console.log('  (dry run - nothing written)')
}

const EARTH_RADIUS_MILES = 3958.7613
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h))
}

// --- main ------------------------------------------------------------------

const main = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set')
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB')

  if (phase === 'addresses' || phase === 'all') await runAddressPhase()
  if (phase === 'geocode' || phase === 'all') await runGeocodePhase()

  const [withAddress, resolved, rooftop, proxies] = await Promise.all([
    LeAgency.countDocuments({ 'contacts.streetAddress.line1': { $exists: true, $nin: ['', null] } }),
    LeAgency.countDocuments({ 'location.resolvedAt': { $ne: null } }),
    LeAgency.countDocuments({ 'location.precision': 'rooftop' }),
    LeAgency.countDocuments({ fbiCoordIsCountyProxy: true }),
  ])

  console.log('\nDatabase totals')
  console.log(`  with a street address ${withAddress}`)
  console.log(`  with resolved coords  ${resolved}`)
  console.log(`    of which rooftop    ${rooftop}`)
  console.log(`  FBI county proxies    ${proxies}`)

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
