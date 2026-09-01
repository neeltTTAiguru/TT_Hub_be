/**
 * US Census geocoder: free, no API key, no per-request quota.
 *
 * Shared by the crosswalk importer and the fallback resolver so both submit
 * addresses the same way and interpret the response the same way.
 */

const BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch'

// Unit designators the geocoder cannot match on. "101 COURT SQ STE G" fails;
// "101 COURT SQ" succeeds.
const UNIT_SUFFIX =
  /\s+\b(STE|SUITE|UNIT|RM|ROOM|APT|BLDG|BUILDING|FL|FLOOR|#)\b\.?\s*[A-Z0-9-]*\s*$/i

// Descriptive nouns appended to an otherwise valid address, e.g.
// "300 WASHINGTON ST COURTHOUSE".
const TRAILING_NOUN =
  /\s+\b(COURT\s?HOUSE|COURTHOUSE|ANNEX|SUBSTATION|HEADQUARTERS|HQ|JAIL|POLICE\s+DEPARTMENT|SHERIFFS?\s+OFFICE|CITY\s+HALL|MUNICIPAL\s+BUILDING)\b\.?\s*$/i

// The geocoder wants the USPS long form for these; the crosswalk abbreviates.
const EXPANSIONS = [
  [/\bSQ\b\.?/g, 'SQUARE'],
  [/\bHWY\b\.?/g, 'HIGHWAY'],
  [/\bCTR\b\.?/g, 'CENTER'],
  [/\bBYP\b\.?/g, 'BYPASS'],
]

/**
 * Cleans a crosswalk address into something the geocoder can match, or returns
 * '' when the line is a building name rather than an address.
 *
 * Returning '' matters: "SHERIFF WS JONES CENTER" has no house number, and
 * submitting it produces either nothing or a confidently wrong match.
 */
export function normalizeStreet(raw) {
  let line = String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim()
  if (!line) return ''

  // Strip repeatedly: an address can carry both a suite and a trailing noun.
  for (let i = 0; i < 3; i += 1) {
    const before = line
    line = line.replace(UNIT_SUFFIX, '').replace(TRAILING_NOUN, '').trim()
    if (line === before) break
  }

  for (const [pattern, replacement] of EXPANSIONS) line = line.replace(pattern, replacement)
  line = line.replace(/\./g, ' ').replace(/\s+/g, ' ').trim()

  // Must start with a house number and keep a street name after it.
  if (!/^\d/.test(line)) return ''
  if (line.split(' ').length < 2) return ''
  return line
}

/** Splits a response row on commas outside quotes; matched addresses contain commas. */
function splitCsvLine(line) {
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

/**
 * Geocodes up to 10,000 rows in one request.
 *
 * `rows` is [{ id, street, city, state, zip }]. Returns a Map keyed by id with
 * { status, lat, lon, matchedAddress, precision }, where status is
 * 'ok' | 'no-match' | 'tie'.
 */
export async function geocodeBatch(rows) {
  const escape = (text) => `"${String(text || '').replace(/"/g, '')}"`
  const csv = rows
    .map((r) => [r.id, r.street, r.city, r.state, r.zip].map(escape).join(','))
    .join('\n')

  const form = new FormData()
  form.append('benchmark', 'Public_AR_Current')
  form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv')

  const response = await fetch(BATCH_URL, { method: 'POST', body: form })
  if (!response.ok) throw new Error(`Census geocoder returned ${response.status}`)

  const results = new Map()
  for (const line of (await response.text()).split('\n')) {
    if (!line.trim()) continue
    const fields = splitCsvLine(line).map((f) => f.replace(/^"|"$/g, '').trim())
    const [id, , indicator, matchType, matchedAddress, coordinates] = fields

    if (indicator !== 'Match') {
      results.set(id, { status: indicator === 'Tie' ? 'tie' : 'no-match' })
      continue
    }

    const [lon, lat] = String(coordinates).split(',').map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      results.set(id, { status: 'no-match' })
      continue
    }

    results.set(id, {
      status: 'ok',
      lat,
      lon,
      matchedAddress,
      // 'Exact' means the house number itself matched, the closest this
      // geocoder gets to a rooftop.
      precision: matchType === 'Exact' ? 'rooftop' : 'street',
    })
  }
  return results
}
