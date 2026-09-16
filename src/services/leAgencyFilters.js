/**
 * The Agency Map's filter vocabulary, in one place.
 *
 * Pulled out of the route so the hub MCP server can scope a call report or an
 * agency search with exactly the words the map uses -- a Hermes cron asking
 * for "Texas sheriffs with no cameras" must land on the same agencies the map
 * would draw for those filters.
 */
export const parseNumber = (value) => {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Shared filter builder so the list, geojson, and stats views stay consistent. */
export const buildFilter = (query) => {
  const filter = {}

  const states = typeof query.state === 'string' ? query.state : query.states
  if (typeof states === 'string' && states.trim()) {
    const list = states.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (list.length) filter.state = list.length === 1 ? list[0] : { $in: list }
  }

  if (typeof query.agencyType === 'string' && query.agencyType.trim()) {
    const list = query.agencyType.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) filter.agencyType = list.length === 1 ? list[0] : { $in: list }
  }

  const minOfficers = parseNumber(query.minOfficers)
  const maxOfficers = parseNumber(query.maxOfficers)
  if (minOfficers !== null || maxOfficers !== null) {
    filter['employment.swornOfficers'] = { $ne: null }
    if (minOfficers !== null) filter['employment.swornOfficers'].$gte = minOfficers
    if (maxOfficers !== null) filter['employment.swornOfficers'].$lte = maxOfficers
  } else if (query.hasOfficerCount === 'true') {
    filter['employment.swornOfficers'] = { $ne: null }
  }

  // CRM overlay: 'matched' = in the HubSpot pipeline, 'unmatched' = never touched.
  if (query.crm === 'matched') filter['crm.matched'] = true
  if (query.crm === 'unmatched') filter['crm.matched'] = { $ne: true }
  if (typeof query.stage === 'string' && query.stage.trim()) {
    const list = query.stage.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) filter['crm.stage'] = list.length === 1 ? list[0] : { $in: list }
  }

  if (query.isNibrs === 'true') filter.isNibrs = true
  if (query.isNibrs === 'false') filter.isNibrs = false

  // Body-worn cameras, per the Atlas of Surveillance. 'none' means nobody has
  // documented one here, which is not the same as the agency having none.
  //
  // A hand-set verdict outranks the imported status, exactly as the map's own
  // colouring does. Without this the two disagree: an agency you marked as
  // having cameras still matched `bwc=unknown` here, so it drew red on the map
  // and a research run would have gone and researched it again anyway.
  const trustedUnset = {
    $or: [
      { 'surveillance.bwc.trustedResearched': { $exists: false } },
      { 'surveillance.bwc.trustedResearched': '' },
    ],
  }
  const verdict = (trusted, status) => ({
    $or: [
      { 'surveillance.bwc.trustedResearched': trusted },
      { $and: [trustedUnset, status] },
    ],
  })
  // $and rather than a bare $or, so a later `{ ...filter, $or: [...] }` spread
  // cannot silently overwrite the camera filter.
  if (query.bwc === 'true') {
    filter.$and = [verdict('has_bwc', { 'surveillance.bwc.status': 'yes' })]
  }
  if (query.bwc === 'false') {
    filter.$and = [verdict('no_bwc', { 'surveillance.bwc.status': 'no' })]
  }
  // Everything except a confirmed yes: the ones still worth a call. The exact
  // complement of bwc=true, so an agency is on one side or the other, never both.
  if (query.bwc === 'not_yes') {
    filter.$and = [{ $nor: [verdict('has_bwc', { 'surveillance.bwc.status': 'yes' })] }]
  }
  if (query.bwc === 'unknown') {
    filter.$and = [
      trustedUnset,
      {
        $or: [
          { 'surveillance.bwc.status': { $exists: false } },
          { 'surveillance.bwc.status': 'unknown' },
        ],
      },
    ]
  }
  if (typeof query.bwcEvidence === 'string' && query.bwcEvidence.trim()) {
    const list = query.bwcEvidence.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) {
      filter['surveillance.bwc.evidence'] = list.length === 1 ? list[0] : { $in: list }
    }
  }
  if (typeof query.bwcVendor === 'string' && query.bwcVendor.trim()) {
    const list = query.bwcVendor.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) {
      filter['surveillance.bwc.vendor'] = list.length === 1 ? list[0] : { $in: list }
    }
  }

  if (typeof query.search === 'string' && query.search.trim()) {
    // Escaped so a stray regex character in the search box cannot break the query.
    const escaped = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    filter.agencyName = { $regex: escaped, $options: 'i' }
  }

  // Bounding box from a map viewport: minLon,minLat,maxLon,maxLat
  if (typeof query.bbox === 'string' && query.bbox.trim()) {
    const parts = query.bbox.split(',').map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      const [minLon, minLat, maxLon, maxLat] = parts
      filter.geo = {
        $geoWithin: {
          $box: [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
        },
      }
    }
  }

  // Radius search for territory planning: near=lat,lon&radiusMiles=50
  if (typeof query.near === 'string' && query.near.trim() && !filter.geo) {
    const [lat, lon] = query.near.split(',').map(Number)
    const radiusMiles = parseNumber(query.radiusMiles) ?? 50
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      filter.geo = {
        $geoWithin: { $centerSphere: [[lon, lat], radiusMiles / 3963.2] },
      }
    }
  }

  return filter
}

/** The run's targeting in words, so the spreadsheet can say what it covers. */
export const describeFilters = (filters = {}) => {
  const parts = []
  parts.push(filters.state ? `States: ${filters.state}` : 'All states')
  if (filters.agencyType) parts.push(`Types: ${filters.agencyType}`)
  if (filters.minOfficers || filters.maxOfficers) {
    parts.push(`Officers: ${filters.minOfficers ?? 'any'} to ${filters.maxOfficers ?? 'any'}`)
  }
  if (filters.bwc === 'unknown') parts.push('Camera status unknown only')
  if (filters.bwc === 'true') parts.push('Known to have cameras')
  if (filters.bwc === 'false') parts.push('Known to have none')
  if (filters.search) parts.push(`Name contains "${filters.search}"`)
  return parts.join('; ')
}
