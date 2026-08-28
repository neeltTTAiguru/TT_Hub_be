/**
 * Name matching between HubSpot deal names and FBI agency names.
 *
 * A HubSpot deal name carries no state column, so the state is dug out of the
 * name itself ("Niles Police Department - OH", "Mansfield PD-LA", "Aberdeen PD,
 * MS"). Matching is then name + state, because "Franklin Police Department"
 * exists in a dozen states and a state-blind match produces confident garbage.
 */

export const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
  'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
])

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', tennessee: 'TN',
  texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  wisconsin: 'WI', wyoming: 'WY',
}

// Boilerplate that says "this is a law enforcement agency" but does not identify
// WHICH one. Deliberately excludes county/college/university/isd/parish: those
// distinguish real, different agencies in the same town.
const ORG_WORDS = new Set([
  'police', 'department', 'departments', 'dept', 'pd', 'sheriff', 'sheriffs',
  'office', 'offices', 'so', 'the', 'of', 'city', 'town', 'village', 'new',
  'deal', 'inc', 'llc', 'and',
])

/** Pulls a state code out of a HubSpot deal name and returns the name without it. */
export function extractState(rawName) {
  let name = String(rawName || '').trim()
  let state = ''

  name = name.replace(/\s*-\s*new deal\s*$/i, '')
  // Trailing parenthetical counts like "(7)" or "(8 Cameras)".
  name = name.replace(/\s*\(\s*\d+[^)]*\)\s*$/i, '')

  const patterns = [
    /[([,]\s*([A-Za-z]{2})\s*[)\]]?\s*$/,   // "(GA)", ", MS"
    /\s[-–]\s*([A-Za-z]{2})\s*$/,            // " - OH"
    /-([A-Za-z]{2})\s*$/,                     // "PD-LA"
    /\s([A-Za-z]{2})\s*$/,                    // "Department MI"
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(name)
    if (match && US_STATES.has(match[1].toUpperCase())) {
      state = match[1].toUpperCase()
      name = name.slice(0, match.index)
      break
    }
  }

  let nameWithStateWord = name
  if (!state) {
    // A spelled-out state ("Columbus Mississippi PD", "City of Union Springs Alabama").
    for (const [word, code] of Object.entries(STATE_NAMES)) {
      const re = new RegExp(`\\b${word}\\b`, 'i')
      if (re.test(name)) {
        state = code
        name = name.replace(re, ' ')
        break
      }
    }
  }

  // A mid-name state fragment such as "Madison County Sheriff-FL - Corrections".
  if (!state) {
    const mid = /[-–]\s*([A-Za-z]{2})\b/.exec(name)
    if (mid && US_STATES.has(mid[1].toUpperCase())) {
      state = mid[1].toUpperCase()
      name = name.slice(0, mid.index) + ' ' + name.slice(mid.index + mid[0].length)
    }
  }

  // Last resort: a bare uppercase state code anywhere in the name, as in
  // "Parker County TX/ Carahsoft". Uppercase-only, so "Co" or "St" cannot match.
  if (!state) {
    const bare = /\b([A-Z]{2})\b/.exec(name)
    if (bare && US_STATES.has(bare[1])) {
      state = bare[1]
      name = name.slice(0, bare.index) + ' ' + name.slice(bare.index + bare[0].length)
    }
  }

  const clean = (value) => value.replace(/\s*[-–,]\s*$/, '').replace(/\s+/g, ' ').trim()
  return { state, name: clean(name), nameWithStateWord: clean(nameWithStateWord) }
}

// HubSpot deal names abbreviate what the FBI spells out.
const ABBREVIATIONS = {
  comm: 'community', community: 'community',
  univ: 'university', jr: 'junior', dist: 'district',
  co: 'county', cnty: 'county', ps: 'safety', st: 'state',
}

/** Reduces an agency name to its identifying tokens. */
export function normalizeAgencyName(rawName) {
  return String(rawName || '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token && !ORG_WORDS.has(token))
    .map((token) => ABBREVIATIONS[token] || token)
    .join(' ')
    .trim()
}

/** Jaccard overlap of the identifying tokens, 0..1. */
export function similarity(a, b) {
  const left = new Set(String(a || '').split(' ').filter(Boolean))
  const right = new Set(String(b || '').split(' ').filter(Boolean))
  if (!left.size || !right.size) return 0

  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}
