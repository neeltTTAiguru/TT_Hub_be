/**
 * Push an agency into HubSpot as a company, and its chief as a contact.
 *
 * Straight to HubSpot's REST API with a private app token. Not through the MCP:
 * HubSpot's hosted MCP exposes no tool that creates a CRM record - its writers
 * are for campaigns, landing pages and marketing email - so this was never
 * possible that way, through Hermes or otherwise.
 *
 * Two rules the shape of this follows:
 *
 *   1. Create or update, never blindly create. The HubSpot ids are stored on
 *      the agency, so a second save patches the same records. A duplicated
 *      company is a quiet failure nobody notices until it matters.
 *   2. Failure never propagates. The SDR's qualification is the artefact worth
 *      protecting; the sync is a convenience, and the caller says plainly when
 *      it did not happen rather than implying it did.
 */
import LeAgency from '../models/LeAgency.js'
import { associate, ensureProperties, findRecord, readRecord, upsertRecord } from './hubspotRest.js'

// A fenced block we own inside HubSpot's standard `description` field.
//
// Qualification has to be readable on the record a rep actually opens, not
// only in our database. Custom properties would be tidier but must exist in
// the portal first, and description is the one rich standard field every
// company already has.
//
// The fence lets a re-save replace our block and leave anything a human wrote
// alone. Writing description outright would delete their notes every time.
const BLOCK_START = '--- Trusted Tech qualification ---'
const BLOCK_END = '--- end Trusted Tech ---'

const qualificationBlock = (agency, sdr = {}) => {
  const bwc = agency.surveillance?.bwc || {}
  const verdict =
    bwc.trustedResearched === 'has_bwc' ? 'Yes' : bwc.trustedResearched === 'no_bwc' ? 'No' : 'Unknown'
  return [
    BLOCK_START,
    `Body-worn cameras: ${verdict}${bwc.vendor ? ` (${bwc.vendor})` : ''}${
      bwc.confidence ? ` - ${bwc.confidence} confidence` : ''
    }`,
    bwc.status === 'purchased_not_deployed' ? 'NOTE: bought but not yet deployed.' : '',
    // The quote is the evidence itself, and the most useful line here: the
    // difference between "our tool says yes" and a sentence a rep can read out.
    bwc.summary ? `Evidence: "${bwc.summary}"` : '',
    bwc.evidenceUrl ? `Source: ${bwc.evidenceUrl}` : '',
    bwc.contractEnd ? `Contract ends: ${new Date(bwc.contractEnd).toISOString().slice(0, 10)}` : '',
    agency.county ? `County: ${agency.county}` : '',
    agency.employment?.swornOfficers ? `Sworn officers: ${agency.employment.swornOfficers}` : '',
    // The join key back to the hub. Without it, matching a HubSpot company to
    // an agency falls back to name, which is what the ORI exists to avoid.
    agency.ori ? `ORI: ${agency.ori}` : '',
    ...(agency.contacts?.commandStaff || [])
      .filter((person) => person?.name)
      .slice(0, 6)
      .map((person) => `Also: ${person.name}${person.title ? ` - ${person.title}` : ''}`),
    '',
    sdr.timeline ? `T - Timeline: ${sdr.timeline}` : '',
    sdr.money ? `M - Money: ${sdr.money}` : '',
    sdr.authority ? `A - Authority: ${sdr.authority}` : '',
    sdr.needs ? `N - Needs: ${sdr.needs}` : '',
    sdr.pain ? `P - Pain: ${sdr.pain}` : '',
    sdr.notes ? `Notes: ${sdr.notes}` : '',
    sdr.filledAt
      ? `Qualified ${new Date(sdr.filledAt).toISOString().slice(0, 10)}${sdr.filledBy ? ` by ${sdr.filledBy}` : ''}`
      : '',
    BLOCK_END,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * The qualification as real HubSpot fields, not prose.
 *
 * The description block above is for reading; these are for working - filtering
 * a list on "no timeline yet", building a view of everyone whose budget cycle
 * opens in October, reporting on how much of a territory has been qualified.
 * None of that is possible against a paragraph.
 *
 * Created on demand the first time an agency is saved, in their own card on the
 * company record. Textarea rather than text because these answers are sentences
 * an SDR typed, not values from a picker.
 */
const SDR_PROPERTY_GROUP = { name: 'trusted_tech_qualification', label: 'Trusted Tech qualification' }

const SDR_PROPERTIES = [
  { name: 'tt_sdr_timeline', label: 'T - Timeline', type: 'string', fieldType: 'textarea' },
  { name: 'tt_sdr_money', label: 'M - Money', type: 'string', fieldType: 'textarea' },
  { name: 'tt_sdr_authority', label: 'A - Authority', type: 'string', fieldType: 'textarea' },
  { name: 'tt_sdr_needs', label: 'N - Needs', type: 'string', fieldType: 'textarea' },
  { name: 'tt_sdr_pain', label: 'P - Pain', type: 'string', fieldType: 'textarea' },
  { name: 'tt_sdr_notes', label: 'SDR notes', type: 'string', fieldType: 'textarea' },
  { name: 'tt_sdr_filled_by', label: 'Qualified by', type: 'string', fieldType: 'text' },
  { name: 'tt_sdr_filled_at', label: 'Qualified on', type: 'date', fieldType: 'date' },
  { name: 'tt_ori', label: 'ORI', type: 'string', fieldType: 'text' },
]

/**
 * Only the fields the portal actually has.
 *
 * Writing a property that does not exist fails the whole company update, taking
 * the description block down with it - so the caller passes in the names it
 * confirmed, and anything absent is silently left out.
 */
const sdrProperties = (agency, sdr, allowed) => {
  const all = {
    tt_sdr_timeline: sdr.timeline || '',
    tt_sdr_money: sdr.money || '',
    tt_sdr_authority: sdr.authority || '',
    tt_sdr_needs: sdr.needs || '',
    tt_sdr_pain: sdr.pain || '',
    tt_sdr_notes: sdr.notes || '',
    tt_sdr_filled_by: sdr.filledBy || '',
    // HubSpot date properties are midnight UTC, and reject a full timestamp.
    tt_sdr_filled_at: sdr.filledAt ? new Date(sdr.filledAt).toISOString().slice(0, 10) : '',
    tt_ori: agency.ori || '',
  }
  return Object.fromEntries(allowed.filter((name) => name in all).map((name) => [name, all[name]]))
}

// The questions as the SDR hears them, so the note reads as a call happening
// rather than a form being filled in. Kept in step with the modal's wording.
const QUESTIONS = [
  ['timeline', 'T - Timeline', 'Assuming you find the correct solution, when would you want a new BWC implemented?'],
  ['money', 'M - Money', 'When does your budget cycle come around, will this project align with your budget?'],
  ['authority', 'A - Authority', 'Who else needs to be involved in this project?'],
  ['needs', 'N - Needs', 'How many cameras would be needed?'],
  ['pain', 'P - Pain', 'What would you say is the reason you are looking at new body cameras?'],
]

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/**
 * The whole form as a timeline note.
 *
 * Properties are for filtering and the description is for a rep skimming the
 * record, but neither is where anyone looks for what was said on a call - the
 * activity timeline is, and a note is the only thing that shows up there and on
 * the contact as well as the company.
 *
 * Every answered question, verbatim, with the question above it: six months on,
 * "October" is meaningless without knowing it answered the budget one.
 */
const qualificationNote = (agency, sdr = {}) => {
  const lines = [
    `<b>TMAN-P qualification - ${escapeHtml(agency.agencyName)}</b>`,
    agency.ori ? `ORI ${escapeHtml(agency.ori)}` : '',
    '',
  ]
  for (const [key, label, question] of QUESTIONS) {
    if (!sdr[key]) continue
    lines.push(`<b>${label}</b>`, `<i>${escapeHtml(question)}</i>`, escapeHtml(sdr[key]), '')
  }
  if (sdr.notes) lines.push('<b>Anything else</b>', escapeHtml(sdr.notes), '')
  if (sdr.filledBy || sdr.filledAt) {
    const on = sdr.filledAt ? new Date(sdr.filledAt).toISOString().slice(0, 10) : ''
    lines.push(`<i>Qualified${on ? ` ${on}` : ''}${sdr.filledBy ? ` by ${escapeHtml(sdr.filledBy)}` : ''}</i>`)
  }
  return lines.join('<br>')
}

/** HubSpot dedupes companies on domain far more reliably than on name. */
const domainOf = (website) => {
  const raw = String(website || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Deliberately crude. These arrive as "Dustin Breshears" or "Erasmo Alarcon
 * Jr." and all that matters is that a human can find the contact; a real name
 * parser would be a lot of code to get a suffix in the right box.
 */
const splitName = (full) => {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { firstname: '', lastname: '' }
  if (parts.length === 1) return { firstname: parts[0], lastname: '' }
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') }
}

/** Swap our block in, preserving whatever a person wrote around it. */
const mergeDescription = (existing, block) => {
  const current = String(existing || '')
  const start = current.indexOf(BLOCK_START)
  if (start === -1) return current ? `${current.trimEnd()}\n\n${block}` : block
  const endMarker = current.indexOf(BLOCK_END, start)
  const end = endMarker === -1 ? current.length : endMarker + BLOCK_END.length
  return (current.slice(0, start) + block + current.slice(end)).trim()
}

export async function syncAgencyToHubSpot(ori) {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() })
    .select('ori agencyName state county contacts crm sdr surveillance.bwc employment.swornOfficers')
    .lean()
  if (!agency) throw new Error(`No agency with ORI ${ori}`)

  const contacts = agency.contacts || {}
  const address = contacts.streetAddress || {}
  const domain = domainOf(contacts.website)
  const { firstname, lastname } = splitName(contacts.chiefName)

  // Find it before creating it. Domain first - HubSpot dedupes companies on
  // domain far more reliably than on a name that half a dozen departments in
  // the state also have.
  let companyId = agency.crm?.hubspotCompanyId || ''
  if (!companyId) {
    companyId =
      (domain && (await findRecord('companies', 'domain', domain))) ||
      (await findRecord('companies', 'name', agency.agencyName))
  }

  // Read the existing description so the fenced block replaces only itself and
  // leaves a rep's own notes alone.
  const existing = companyId ? await readRecord('companies', companyId, ['description']) : {}

  // Whichever of our fields the portal has, or that we could just create. On a
  // token without schema scope this is empty and the write below is the same
  // one it always was.
  const allowed = await ensureProperties('companies', SDR_PROPERTY_GROUP, SDR_PROPERTIES)

  companyId = await upsertRecord(
    'companies',
    {
      name: agency.agencyName,
      ...(domain ? { domain } : {}),
      ...(contacts.website ? { website: contacts.website } : {}),
      ...(contacts.phone ? { phone: contacts.phone } : {}),
      ...(address.line1 ? { address: address.line1 } : {}),
      ...(address.city ? { city: address.city } : {}),
      ...(agency.state ? { state: agency.state } : {}),
      ...(address.zip ? { zip: address.zip } : {}),
      description: mergeDescription(existing.description, qualificationBlock(agency, agency.sdr || {})),
      ...sdrProperties(agency, agency.sdr || {}, allowed),
    },
    companyId,
  )

  // A contact needs a person. A nameless, emailless one is a row nobody can
  // act on and another thing to deduplicate later.
  let contactId = agency.crm?.hubspotContactId || ''
  const hasPerson = Boolean(firstname || contacts.email)
  if (hasPerson) {
    if (!contactId && contacts.email) {
      contactId = await findRecord('contacts', 'email', contacts.email)
    }
    contactId = await upsertRecord(
      'contacts',
      {
        ...(firstname ? { firstname } : {}),
        ...(lastname ? { lastname } : {}),
        ...(contacts.email ? { email: contacts.email } : {}),
        ...(contacts.phone ? { phone: contacts.phone } : {}),
        ...(contacts.chiefTitle ? { jobtitle: contacts.chiefTitle } : {}),
        ...(agency.agencyName ? { company: agency.agencyName } : {}),
      },
      contactId,
    )
    // A failed link is not worth losing two good records over.
    try {
      await associate('contacts', contactId, 'companies', companyId)
    } catch {
      /* both records exist; they can be linked by hand */
    }
  }

  // The timeline copy. One note per agency, patched on a re-save rather than
  // added to: an SDR correcting a typo should not leave two versions of the
  // same call on the record for the next person to reconcile.
  //
  // Last, and swallowed, on purpose. The company and contact are already
  // written by this point, and losing the note is not worth reporting the whole
  // sync as failed.
  let noteId = agency.crm?.hubspotSdrNoteId || ''
  try {
    noteId = await upsertRecord(
      'notes',
      {
        hs_note_body: qualificationNote(agency, agency.sdr || {}),
        // HubSpot places the note on the timeline by this, and rejects a create
        // without it. Kept at the original stamp on a re-save so an edit does
        // not jump the call to today.
        hs_timestamp: new Date(agency.sdr?.filledAt || Date.now()).toISOString(),
      },
      noteId,
    )
    await associate('notes', noteId, 'companies', companyId)
    if (contactId) await associate('notes', noteId, 'contacts', contactId)
  } catch {
    noteId = agency.crm?.hubspotSdrNoteId || ''
  }

  await LeAgency.updateOne(
    { ori: agency.ori },
    {
      $set: {
        'crm.hubspotCompanyId': companyId,
        ...(contactId ? { 'crm.hubspotContactId': contactId } : {}),
        ...(noteId ? { 'crm.hubspotSdrNoteId': noteId } : {}),
        'crm.hubspotSyncedAt': new Date(),
        'crm.hubspotSyncError': '',
      },
    },
  )

  return {
    companyId,
    contactId,
    noteId,
    // Named so the caller can say what actually happened rather than implying
    // the structured copy landed when the token could not create the fields.
    propertiesWritten: allowed.length,
    contactSkipped: hasPerson ? '' : 'No chief name or email on file, so no contact was created.',
  }
}
