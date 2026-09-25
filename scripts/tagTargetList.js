/**
 * Puts an uploaded list of agencies on the map as the purple "Target list".
 *
 * Lists arrive as free text - "Sequim Police Department - WA", "Beulaville PD
 * NC", "Sampson CSO NC" - and agencies are keyed by ORI, so every line has to
 * be matched to one. Names repeat across states (there are dozens of
 * Springfield PDs), so the state on the line is used whenever there is one,
 * and a line with no state only matches when its name is unique nationally.
 *
 * Only confident matches are tagged: the whole name, after expanding the
 * usual abbreviations, equals the agency's name or one of its recorded
 * spellings. Everything else lands in the report for a human to decide, with
 * the nearest candidates listed.
 *
 *   node scripts/tagTargetList.js list.xlsx             # dry run: report only
 *   node scripts/tagTargetList.js list.xlsx --apply     # replace the list
 *   node scripts/tagTargetList.js --clear               # take the list off
 *
 * Extra ORIs a human picked out of the report can be forced on with
 * --add=ORI1,ORI2. The report is written next to the input as
 * <input>.matches.csv.
 */
import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import ExcelJS from 'exceljs'
import LeAgency from '../src/models/LeAgency.js'

dotenv.config()

const LIST_NAME = 'Target list'

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}
const CODES = new Set(Object.values(STATES))

/**
 * Splits "Name - ST", "Name (ST)", "Name ST", "Name- Texas" into name + state.
 * A trailing two-letter word is only a state when it is a real state code, so
 * "Real CO Constable" keeps its CO (county) rather than being sent to Colorado.
 */
export function parseLine(line) {
  let name = String(line).replace(/\s+/g, ' ').trim()
  let state = ''
  const paren = name.match(/^(.*?)\s*\(([A-Za-z]{2})\)\s*$/)
  const dashed = name.match(/^(.*?)\s*-\s*([A-Za-z .]+?)\s*$/)
  const bare = name.match(/^(.*?)\s+([A-Z]{2})\s*$/)
  if (paren && CODES.has(paren[2].toUpperCase())) {
    ;[name, state] = [paren[1], paren[2].toUpperCase()]
  } else if (dashed && CODES.has(dashed[2].toUpperCase())) {
    ;[name, state] = [dashed[1], dashed[2].toUpperCase()]
  } else if (dashed && STATES[dashed[2].toLowerCase()]) {
    ;[name, state] = [dashed[1], STATES[dashed[2].toLowerCase()]]
  } else if (bare && CODES.has(bare[2])) {
    ;[name, state] = [bare[1], bare[2]]
  }
  return { name: name.replace(/[\s-]+$/, '').trim(), state }
}

const ABBREVIATIONS = [
  [/\bpd\b/g, 'police department'],
  [/\bdept\b/g, 'department'],
  [/\bcso\b/g, 'county sheriffs office'],
  [/\bso\b/g, 'sheriffs office'],
  [/\bisd\b/g, 'independent school district'],
  [/\bco\b/g, 'county'],
  [/\btwp\b/g, 'township'],
  [/\bst\b/g, 'saint'],
  [/\bmt\b/g, 'mount'],
  [/\buniv\b/g, 'university'],
  [/\bunc\b/g, 'university of north carolina'],
  [/\bcross roads\b/g, 'crossroads'],
  [/\btribe\b/g, 'tribal'],
  // "Stanhope Borough Police Department" is filed as "Stanhope Police
  // Department"; the township, where there is one, keeps its own word.
  [/\bborough\b/g, ''],
  // "Dawson County Sheriff" means the sheriff's office.
  [/\bsheriff$/g, 'sheriffs office'],
  // A sheriff's department and a sheriff's office are the same agency; the
  // FBI and the list-writers just disagree on the word.
  [/\bsheriffs department\b/g, 'sheriffs office'],
  [/\bsheriff department\b/g, 'sheriffs office'],
  [/\bsheriff office\b/g, 'sheriffs office'],
  [/\bmarshals office\b/g, 'marshal'],
  [/\bmarshal office\b/g, 'marshal'],
]

export function normalize(name) {
  // The FBI files school district police as "Independent School District:
  // Silsbee"; lists say "Silsbee ISD" or "Silsbee ISD PD". Both become
  // "silsbee independent school district".
  let text = String(name).replace(/^(independent school district|consolidated independent school district):\s*(.+)$/i, '$2 $1')
  text = text
    .toLowerCase()
    .replace(/[’'`.]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  for (const [pattern, replacement] of ABBREVIATIONS) text = text.replace(pattern, replacement)
  text = text.replace(/\b(independent school district) police department$/, '$1')
  return text.replace(/^(the|city of|town of|village of) /, '').replace(/\s+/g, ' ').trim()
}

// The words that say what kind of agency it is, not which one.
const GENERIC = new Set([
  'police', 'department', 'sheriffs', 'office', 'county', 'city', 'town', 'village', 'township',
  'marshal', 'marshals', 'sheriff', 'public', 'safety', 'of', 'the', 'and', 'law', 'enforcement',
  'agency', 'tribal', 'band', 'charter', 'constable', 'independent', 'school', 'district',
])
const core = (normalized) => normalized.split(' ').filter((w) => !GENERIC.has(w)).join(' ')

async function readList(file) {
  if (/\.csv$|\.txt$/i.test(file)) {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.split(',')[0]).filter((l) => l.trim())
  }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  const lines = []
  workbook.worksheets[0].eachRow((row) => {
    const value = row.getCell(1).text?.trim()
    if (value) lines.push(value)
  })
  return lines
}

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`

async function run() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const clear = args.includes('--clear')
  const forced = (args.find((a) => a.startsWith('--add=')) || '').slice(6).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const file = args.find((a) => !a.startsWith('--'))

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) throw new Error('MONGODB_URI is not set.')
  await mongoose.connect(uri)

  if (clear) {
    const result = await LeAgency.updateMany({ 'targetList.name': { $gt: '' } }, { $unset: { targetList: 1 } })
    console.log(`Took ${result.modifiedCount} agencies off the ${LIST_NAME}.`)
    await mongoose.disconnect()
    return
  }
  if (!file) throw new Error('Pass the list file (xlsx or csv).')

  const lines = await readList(file)
  const agencies = await LeAgency.find({ isTestRecord: { $ne: true } })
    .select('ori agencyName nameVariants state agencyType county employment.swornOfficers')
    .lean()

  // Every spelling of every agency, by full normalized name and by core name.
  const byFull = new Map()
  const byCore = new Map()
  const push = (map, key, agency) => {
    if (!key) return
    const list = map.get(key) || []
    if (!list.includes(agency)) list.push(agency)
    map.set(key, list)
  }
  for (const agency of agencies) {
    for (const spelling of [agency.agencyName, ...(agency.nameVariants || [])]) {
      const full = normalize(spelling)
      push(byFull, full, agency)
      push(byCore, core(full), agency)
    }
  }

  const rows = []
  for (const line of lines) {
    const { name, state } = parseLine(line)
    const full = normalize(name)
    const inState = (list) => (state ? list.filter((a) => a.state === state) : list)
    const exact = inState(byFull.get(full) || [])
    const nearby = inState(byCore.get(core(full)) || [])
    let status
    let match = null
    let candidates = []
    if (exact.length === 1) {
      status = 'matched'
      match = exact[0]
    } else if (exact.length > 1) {
      status = 'ambiguous'
      candidates = exact
    } else if (nearby.length) {
      // Same place name, different agency kind or wording - e.g. the list
      // says "Wilkes CSO" and the database has "Wilkes County Sheriff's
      // Office", or it says a PD where only the sheriff is on file.
      status = 'review'
      candidates = nearby
    } else {
      status = 'not found'
    }
    rows.push({ line, name, state, status, match, candidates })
  }

  const report = [
    ['List line', 'Parsed state', 'Status', 'ORI', 'Matched agency', 'State', 'Officers', 'Candidates (ORI - name - state)'],
    ...rows.map((r) => [
      r.line,
      r.state,
      r.status,
      r.match?.ori || '',
      r.match?.agencyName || '',
      r.match?.state || '',
      r.match?.employment?.swornOfficers ?? '',
      r.candidates.slice(0, 6).map((c) => `${c.ori} - ${c.agencyName} - ${c.state}`).join(' | '),
    ]),
  ]
  const out = `${file.replace(/\.[^.]+$/, '')}.matches.csv`
  fs.writeFileSync(out, report.map((r) => r.map(csvCell).join(',')).join('\n'))

  const tally = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {})
  console.log(`${lines.length} lines:`, tally)
  console.log(`Report: ${path.resolve(out)}`)

  const toTag = new Map(rows.filter((r) => r.match).map((r) => [r.match.ori, r.line]))
  for (const ori of forced) if (!toTag.has(ori)) toTag.set(ori, '(added by hand)')

  if (!apply) {
    console.log(`Dry run: would tag ${toTag.size} agencies. Re-run with --apply to write.`)
    await mongoose.disconnect()
    return
  }

  // Replace, not append: the list on the map is the list that was uploaded.
  await LeAgency.updateMany(
    { 'targetList.name': { $gt: '' }, ori: { $nin: [...toTag.keys()] } },
    { $unset: { targetList: 1 } },
  )
  const addedAt = new Date()
  const result = await LeAgency.bulkWrite(
    [...toTag].map(([ori, sourceName]) => ({
      updateOne: {
        filter: { ori },
        update: { $set: { targetList: { name: LIST_NAME, sourceName, addedAt } } },
      },
    })),
  )
  console.log(`Tagged ${result.matchedCount} agencies as "${LIST_NAME}".`)
  await mongoose.disconnect()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (error) => {
    console.error(error)
    await mongoose.disconnect().catch(() => {})
    process.exit(1)
  })
}
