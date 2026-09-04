/**
 * The spreadsheet a research run hands back.
 *
 * One row per agency, one sheet. The three things every run must produce -
 * cameras with reasoning, a decision maker with an email, a phone number - lead
 * the sheet; everything else is supporting detail behind them.
 *
 * Every claim is paired with where it came from and when. A camera verdict with
 * no source and no date is not usable by a salesperson, and it is worse than a
 * blank cell because it looks like an answer.
 */
import ExcelJS from 'exceljs'

/**
 * A hand-set verdict outranks the imported status, exactly as the map's
 * colouring and the camera filter do. Keep these three in step.
 */
const verdictOf = (bwc = {}) => {
  if (bwc.trustedResearched === 'has_bwc') return 'Yes'
  if (bwc.trustedResearched === 'no_bwc') return 'No'
  if (bwc.status === 'yes') return 'Yes'
  if (bwc.status === 'no') return 'No'
  return 'Unknown'
}

const EVIDENCE_LABELS = {
  observed: 'Camera documented in the field',
  surveyed: "The agency's own survey answer",
  funded: 'Awarded a camera grant',
  mandated: 'Covered by a state mandate',
  researched: 'Researched by the traveller',
}

const sourceOf = (bwc = {}) => {
  if (bwc.trustedResearched) {
    return bwc.trustedResearchedBy === 'manual' ? 'Set by hand' : 'Researched by the traveller'
  }
  return EVIDENCE_LABELS[bwc.evidence] || (bwc.status && bwc.status !== 'unknown' ? bwc.source || '' : '')
}

/** A mandate is a legal duty, not a receipt. Say so in the row, not the notes. */
const caveatOf = (bwc = {}) => {
  // Bought but not yet in use is the most sellable answer in the sheet and the
  // easiest to lose: the verdict column says "Yes" for it, same as an agency
  // that has been filming for a decade. Keep the distinction visible.
  if (bwc.status === 'purchased_not_deployed') {
    return 'Bought but not yet deployed - live opportunity'
  }
  if (bwc.status === 'planned') return 'Budgeted or announced only - nothing bought yet'
  if (bwc.trustedResearched) return ''
  if (bwc.evidence === 'mandated') return 'State mandate - a legal duty, not a verified purchase'
  if (bwc.evidence === 'funded') return 'Grant funded - awarded, not confirmed deployed'
  return ''
}

const COLUMNS = [
  { header: 'ORI', key: 'ori', width: 11 },
  { header: 'Agency', key: 'agency', width: 34 },
  { header: 'Type', key: 'type', width: 16 },
  { header: 'County', key: 'county', width: 18 },
  { header: 'State', key: 'state', width: 7 },

  { header: 'Body-worn cameras', key: 'cameras', width: 17 },
  { header: 'How we know', key: 'cameraSource', width: 30 },
  { header: 'Reasoning', key: 'reasoning', width: 60 },
  { header: 'Caveat', key: 'caveat', width: 34 },
  { header: 'Camera source URL', key: 'cameraUrl', width: 42 },
  { header: 'Camera status as of', key: 'cameraAsOf', width: 14 },
  { header: 'Confidence', key: 'confidence', width: 11 },
  { header: 'Vendor', key: 'vendor', width: 18 },
  { header: 'Contract ends', key: 'contractEnd', width: 13 },

  { header: 'Decision maker', key: 'chief', width: 24 },
  { header: 'Title', key: 'chiefTitle', width: 20 },
  { header: 'Email', key: 'email', width: 30 },
  { header: 'Contact source URL', key: 'contactUrl', width: 42 },
  { header: 'Contact verified', key: 'contactVerified', width: 14 },

  { header: 'Phone', key: 'phone', width: 16 },
  { header: 'Website', key: 'website', width: 34 },

  { header: 'Sworn officers', key: 'officers', width: 13 },
]

const rowFor = (agency) => {
  const bwc = agency.surveillance?.bwc || {}
  const contacts = agency.contacts || {}
  return {
    ori: agency.ori || '',
    agency: agency.agencyName || '',
    type: agency.agencyType || '',
    county: agency.county || '',
    state: agency.state || '',

    cameras: verdictOf(bwc),
    cameraSource: sourceOf(bwc),
    reasoning: bwc.summary || bwc.trustedResearchedNote || '',
    caveat: caveatOf(bwc),
    cameraUrl: bwc.evidenceUrl || '',
    cameraAsOf: bwc.asOf || bwc.trustedResearchedAt || null,
    confidence: bwc.confidence || '',
    vendor: bwc.vendor || bwc.vendorRaw || '',
    contractEnd: bwc.contractEnd || '',

    chief: contacts.chiefName || '',
    chiefTitle: contacts.chiefTitle || '',
    email: contacts.email || '',
    contactUrl: contacts.chiefSourceUrl || '',
    contactVerified: contacts.chiefVerifiedAt || null,

    phone: contacts.phone || '',
    website: contacts.website || '',

    officers: agency.employment?.swornOfficers ?? null,
  }
}

export async function buildResearchRunWorkbook(agencies, meta = {}) {
  const book = new ExcelJS.Workbook()
  book.creator = 'Trusted Technology Smart Hub'
  book.created = new Date()

  const sheet = book.addWorksheet('Research run', {
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  sheet.columns = COLUMNS

  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }
  header.height = 20

  for (const agency of agencies) sheet.addRow(rowFor(agency))

  sheet.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } }
  for (const key of ['cameraAsOf', 'contactVerified']) {
    sheet.getColumn(key).numFmt = 'yyyy-mm-dd'
  }
  sheet.getColumn('reasoning').alignment = { wrapText: true, vertical: 'top' }
  sheet.getColumn('caveat').alignment = { wrapText: true, vertical: 'top' }

  // A second sheet recording what this run was, so a spreadsheet found on
  // someone's desktop in three months can still say what it covers.
  const about = book.addWorksheet('About this run')
  about.columns = [
    { header: 'Field', key: 'field', width: 26 },
    { header: 'Value', key: 'value', width: 80 },
  ]
  about.getRow(1).font = { bold: true }
  for (const [field, value] of Object.entries(meta)) {
    about.addRow({ field, value: value === '' || value == null ? '-' : String(value) })
  }
  about.addRow({ field: 'Rows', value: String(agencies.length) })
  about.addRow({ field: 'Generated', value: new Date().toISOString() })

  return Buffer.from(await book.xlsx.writeBuffer())
}
