/**
 * Links a HubSpot deal export onto the agency map.
 *
 * A deal matching an FBI agency by name+state IS a law enforcement deal; one
 * that matches nothing is something else (a casino, a utility, a repo company).
 * So the match itself does the classifying — there is no separate filter.
 *
 *   node scripts/importHubspotDeals.js --file="/path/to/deals.csv"
 *   node scripts/importHubspotDeals.js --file=... --dry-run --report
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'
import CrmDeal from '../src/models/CrmDeal.js'
import { extractState, normalizeAgencyName, similarity } from '../src/services/agencyNameMatch.js'

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
const showReport = args.report === 'true'
const threshold = Number(args.threshold || 0.85)

// Pipeline order. Terminal-negative stages rank below any live stage so an
// active deal always wins when one agency carries several.
const STAGE_RANK = {
  'No Further Interest': 0,
  'Closed Lost': 1,
  'Qualified Lead': 2,
  'Presentation / Demonstration Completed': 3,
  'Trial Requested': 4,
  'Trial Agreement Sent': 5,
  'Trial In Progress': 6,
  'Quote Sent': 7,
  'Contract Sent': 8,
  'Closed Won': 9,
}

/** Minimal RFC4180 parser: the export quotes fields that contain commas. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (ch !== '\r') field += ch
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim()))
}

const main = async () => {
  const file = args.file
  if (!file) throw new Error('Pass --file="/path/to/hubspot-deals.csv"')
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set')

  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  const header = rows[0]
  const col = (name) => header.indexOf(name)
  const idIdx = col('Record ID')
  const nameIdx = col('Deal Name')
  const stageIdx = col('Deal Stage')
  const ownerIdx = col('Deal owner')
  if (nameIdx < 0 || stageIdx < 0) throw new Error('CSV is missing "Deal Name" or "Deal Stage"')

  const deals = rows.slice(1).map((r) => ({
    dealId: r[idIdx] || '',
    dealName: r[nameIdx] || '',
    stage: r[stageIdx] || '',
    owner: r[ownerIdx] || '',
  })).filter((d) => d.dealName.trim())

  await mongoose.connect(process.env.MONGODB_URI)
  console.log(`Parsed ${deals.length} deals from the export\n`)

  const agencies = await LeAgency.find().select('ori agencyName state county latitude longitude').lean()
  const byState = new Map()
  for (const agency of agencies) {
    const key = agency.state || '??'
    if (!byState.has(key)) byState.set(key, [])
    byState.get(key).push({ ...agency, norm: normalizeAgencyName(agency.agencyName) })
  }
  const allNorm = new Map()
  for (const agency of agencies) {
    const norm = normalizeAgencyName(agency.agencyName)
    if (!allNorm.has(norm)) allNorm.set(norm, [])
    allNorm.get(norm).push(agency)
  }

  const matches = []
  const unmatched = []
  const parsed = new Map()

  for (const deal of deals) {
    const { state, name, nameWithStateWord } = extractState(deal.dealName)
    parsed.set(deal.dealId, { state, name })
    // Two readings of the name: with and without the spelled-out state word.
    // "Columbus Mississippi PD" needs it dropped; "Georgia Military College"
    // needs it kept. Score both and take whichever fits better.
    const forms = [...new Set([normalizeAgencyName(name), normalizeAgencyName(nameWithStateWord)])].filter(Boolean)
    const norm = forms[0]
    if (!norm) { unmatched.push({ ...deal, reason: 'empty name' }); continue }
    const scoreAgainst = (candidateNorm) => Math.max(...forms.map((f) => similarity(f, candidateNorm)))

    if (state) {
      const pool = byState.get(state) || []
      const exact = pool.filter((a) => forms.includes(a.norm))
      if (exact.length === 1) {
        matches.push({ deal, agency: exact[0], method: 'exact', confidence: 1 })
        continue
      }
      if (exact.length > 1) {
        unmatched.push({ ...deal, reason: `ambiguous: ${exact.length} agencies named "${norm}" in ${state}` })
        continue
      }
      let best = null
      for (const candidate of pool) {
        const score = scoreAgainst(candidate.norm)
        if (!best || score > best.score) best = { candidate, score }
      }
      if (best && best.score >= threshold) {
        matches.push({ deal, agency: best.candidate, method: 'fuzzy', confidence: best.score })
      } else {
        unmatched.push({
          ...deal,
          reason: best
            ? `no ${state} agency above ${threshold} (best "${best.candidate.agencyName}" @ ${best.score.toFixed(2)})`
            : `no agencies known in ${state}`,
        })
      }
      continue
    }

    // No state in the deal name: only accept a nationally unique exact match.
    const candidates = forms.flatMap((f) => allNorm.get(f) || [])
    if (candidates.length === 1) {
      matches.push({ deal, agency: candidates[0], method: 'exact-nostate', confidence: 0.9 })
    } else {
      unmatched.push({
        ...deal,
        reason: candidates.length
          ? `no state given and ${candidates.length} agencies share the name`
          : 'no state given and no name match',
      })
    }
  }

  // Several deals can land on one agency; keep them all, surface the furthest.
  const byOri = new Map()
  for (const m of matches) {
    if (!byOri.has(m.agency.ori)) byOri.set(m.agency.ori, [])
    byOri.get(m.agency.ori).push(m)
  }

  if (!dryRun) {
    const ops = []
    for (const [ori, group] of byOri) {
      const ranked = [...group].sort(
        (a, b) => (STAGE_RANK[b.deal.stage] ?? -1) - (STAGE_RANK[a.deal.stage] ?? -1),
      )
      const top = ranked[0]
      const best = group.reduce((a, b) => (b.confidence > a.confidence ? b : a))
      ops.push({
        updateOne: {
          filter: { ori },
          update: {
            $set: {
              crm: {
                matched: true,
                stage: top.deal.stage,
                stageRank: STAGE_RANK[top.deal.stage] ?? null,
                owner: top.deal.owner,
                dealCount: group.length,
                deals: group.map((g) => ({
                  dealId: g.deal.dealId,
                  dealName: g.deal.dealName,
                  stage: g.deal.stage,
                  owner: g.deal.owner,
                })),
                matchMethod: best.method,
                matchConfidence: best.confidence,
                importedAt: new Date(),
              },
            },
          },
        },
      })
    }
    // Clear any prior import so a re-run never leaves stale links behind.
    await LeAgency.updateMany({ 'crm.matched': true }, { $set: { crm: { matched: false } } })
    if (ops.length) await LeAgency.bulkWrite(ops, { ordered: false })
  }

  // ---- every deal gets a pin, matched or not -------------------------------
  const overridesPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', 'data', 'crm-deal-locations.json',
  )
  let overrides = {}
  try {
    overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'))
  } catch { overrides = {} }

  const matchByDealId = new Map(matches.map((m) => [m.deal.dealId, m]))
  const located = agencies.filter((a) => Number.isFinite(a.latitude) && Number.isFinite(a.longitude))

  const resolveLocation = (deal) => {
    const override = overrides[deal.dealName]
    if (override && Number.isFinite(override.latitude) && Number.isFinite(override.longitude)) {
      return {
        latitude: override.latitude,
        longitude: override.longitude,
        source: 'manual',
        note: override.note || 'manual override',
      }
    }

    const match = matchByDealId.get(deal.dealId)
    if (match) {
      const agency = located.find((a) => a.ori === match.agency.ori)
      if (agency) {
        return {
          latitude: agency.latitude,
          longitude: agency.longitude,
          source: 'exact',
          note: agency.agencyName,
        }
      }
    }

    const info = parsed.get(deal.dealId) || {}
    const state = info.state || ''

    if (!state) {
      // "City of Muskegon_Safebuilt" carries no state, but every Muskegon agency
      // sits in MI, so the place name alone is unambiguous.
      // Only chance a state-less place lookup when the deal name actually reads
      // like a government body. Without this, "Parkside Restoration" (a private
      // firm) silently lands on Parkside Police Department in Pennsylvania.
      const looksGovernmental =
        /\b(police|sheriff|marshal|constable|city of|town of|village of|county|parish|department|dept|pd|public safety)\b/i
          .test(deal.dealName)
      const token = normalizeAgencyName(String(info.name || '').replace(/_/g, ' ')).split(' ')[0]
      if (looksGovernmental && token && token.length > 3) {
        const hits = located.filter((a) => normalizeAgencyName(a.agencyName).split(' ')[0] === token)
        const statesHit = new Set(hits.map((a) => a.state))
        if (hits.length && statesHit.size === 1) {
          // Prefer the agency whose name IS the place, not one that merely
          // starts with it: Muskegon PD over Muskegon Heights PD.
          const best =
            hits.find((a) => normalizeAgencyName(a.agencyName) === token) ||
            hits.find((a) => /police department/i.test(a.agencyName)) ||
            hits[0]
          return {
            latitude: best.latitude,
            longitude: best.longitude,
            source: 'place-proxy',
            note: `approximate: near ${best.agencyName}`,
          }
        }
      }
      return { latitude: null, longitude: null, source: 'none', note: 'no state in deal name' }
    }

    // "Palo Pinto County Juvenile Probation" sits in Palo Pinto County, so the
    // county sheriff's coordinates put the pin in the right place.
    const countyMatch = /\b([A-Za-z][A-Za-z .'-]*?)\s+county\b/i.exec(info.name || '')
    if (countyMatch) {
      const county = countyMatch[1].trim().toLowerCase()
      const inCounty = located.filter(
        (a) => a.state === state && String(a.county || '').toLowerCase() === county,
      )
      const sheriff = inCounty.find((a) => /sheriff/i.test(a.agencyName)) || inCounty[0]
      if (sheriff) {
        return {
          latitude: sheriff.latitude,
          longitude: sheriff.longitude,
          source: 'county-proxy',
          note: `approximate: ${sheriff.county} County, ${state}`,
        }
      }
    }

    // "City of Muskegon_Safebuilt" -> the Muskegon PD coordinates.
    const place = normalizeAgencyName(String(info.name || '').replace(/_/g, ' '))
    if (place) {
      const first = place.split(' ')[0]
      const hit = located.find(
        (a) => a.state === state && normalizeAgencyName(a.agencyName) === place,
      ) || located.find(
        (a) => a.state === state && normalizeAgencyName(a.agencyName) === first,
      )
      if (hit) {
        return {
          latitude: hit.latitude,
          longitude: hit.longitude,
          source: 'place-proxy',
          note: `approximate: near ${hit.agencyName}`,
        }
      }
    }

    // State known but nothing finer: a state centroid is a poor pin, but an
    // explicit approximation beats dropping the deal off the map entirely.
    const inState = located.filter((a) => a.state === state)
    if (inState.length) {
      const lat = inState.reduce((sum, a) => sum + a.latitude, 0) / inState.length
      const lon = inState.reduce((sum, a) => sum + a.longitude, 0) / inState.length
      return {
        latitude: lat,
        longitude: lon,
        source: 'state-proxy',
        note: `very approximate: centre of ${state}`,
      }
    }
    return { latitude: null, longitude: null, source: 'none', note: `state ${state}, location unknown` }
  }

  if (!dryRun) {
    const dealOps = deals.map((deal) => {
      const loc = resolveLocation(deal)
      const match = matchByDealId.get(deal.dealId)
      const set = {
        dealName: deal.dealName,
        stage: deal.stage,
        stageRank: STAGE_RANK[deal.stage] ?? null,
        owner: deal.owner,
        state: (parsed.get(deal.dealId) || {}).state || '',
        ori: match ? match.agency.ori : '',
        matchedAgencyName: match ? match.agency.agencyName : '',
        isLawEnforcement: Boolean(match),
        latitude: loc.latitude,
        longitude: loc.longitude,
        locationSource: loc.source,
        locationNote: loc.note,
        importedAt: new Date(),
      }
      if (loc.latitude !== null && loc.longitude !== null) {
        set.geo = { type: 'Point', coordinates: [loc.longitude, loc.latitude] }
      } else {
        set.geo = undefined
      }
      return {
        updateOne: {
          filter: { dealId: deal.dealId },
          update: { $set: set, $setOnInsert: { dealId: deal.dealId } },
          upsert: true,
        },
      }
    })
    if (dealOps.length) await CrmDeal.bulkWrite(dealOps, { ordered: false })
  }

  const locStats = {}
  for (const deal of deals) {
    const loc = resolveLocation(deal)
    locStats[loc.source] = (locStats[loc.source] || 0) + 1
  }

  console.log(`Matched   ${matches.length} deals -> ${byOri.size} agencies`)
  console.log(`  exact             ${matches.filter((m) => m.method === 'exact').length}`)
  console.log(`  fuzzy             ${matches.filter((m) => m.method === 'fuzzy').length}`)
  console.log(`  exact (no state)  ${matches.filter((m) => m.method === 'exact-nostate').length}`)
  console.log(`Unmatched ${unmatched.length} deals (not US law enforcement, or name too different)`)

  console.log('\nAll deals pinned by location source:')
  for (const [source, n] of Object.entries(locStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${source}`)
  }

  const stageCounts = {}
  for (const [, group] of byOri) {
    const ranked = [...group].sort((a, b) => (STAGE_RANK[b.deal.stage] ?? -1) - (STAGE_RANK[a.deal.stage] ?? -1))
    const stage = ranked[0].deal.stage || 'Unknown'
    stageCounts[stage] = (stageCounts[stage] || 0) + 1
  }
  console.log('\nAgencies by furthest stage:')
  for (const [stage, n] of Object.entries(stageCounts).sort((a, b) => (STAGE_RANK[b[0]] ?? -1) - (STAGE_RANK[a[0]] ?? -1))) {
    console.log(`  ${String(n).padStart(3)}  ${stage}`)
  }

  if (showReport) {
    console.log('\n--- fuzzy matches, worth a spot check ---')
    for (const m of matches.filter((x) => x.method === 'fuzzy')) {
      console.log(`  ${m.confidence.toFixed(2)}  "${m.deal.dealName}"  ->  ${m.agency.agencyName} (${m.agency.state})`)
    }
    console.log('\n--- unmatched ---')
    for (const u of unmatched) console.log(`  "${u.dealName}"  [${u.stage}]  ${u.reason}`)
  }

  if (dryRun) console.log('\n(dry run - nothing written)')
  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
