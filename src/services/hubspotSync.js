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
import { associate, call, ensureProperties, findRecord, listOwners, readRecord, upsertRecord } from './hubspotRest.js'
import { findOwnerForEmail } from './hubspotMapCalls.js'

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

/**
 * The term-left answer as a reminder date: the earliest the contract could
 * end, so the call to them lands while they are choosing what comes next
 * rather than after. `<1` has no earliest, so it is half a year out.
 */
export const BWC_TERMS = { '<1': 6, '1-2': 12, '2-4': 24, '5+': 60 }
export const BWC_TERM_LABELS = { '<1': '<1 year', '1-2': '1-2 years', '2-4': '2-4 years', '5+': '5+ years' }

export function bwcReviewDate(termLeft, from = new Date()) {
  const months = BWC_TERMS[termLeft]
  if (!months) return null
  const due = new Date(from)
  due.setMonth(due.getMonth() + months)
  return due
}

const bwcContractLine = (contract = {}) => {
  if (contract.status === 'none') return 'BWC contract (told to SDR): none'
  if (contract.status !== 'under_contract') return ''
  return `BWC contract (told to SDR): ${contract.vendor || 'vendor not given'}${
    contract.termLeft ? `, ${BWC_TERM_LABELS[contract.termLeft] || contract.termLeft} left` : ''
  }`
}

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
    bwcContractLine(agency.bwcContract),
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
 * What the agency said about its camera contract, as fields a list can be
 * filtered on - "everyone on Axon with under a year left" is the future
 * prospect list. Text rather than dropdowns so a new vendor never needs a
 * schema change.
 */
const BWC_PROPERTY_GROUP = { name: 'trusted_tech_bwc', label: 'Trusted Tech BWC contract' }

const BWC_PROPERTIES = [
  { name: 'tt_bwc_contract', label: 'BWC contract', type: 'string', fieldType: 'text' },
  { name: 'tt_bwc_vendor', label: 'BWC vendor', type: 'string', fieldType: 'text' },
  { name: 'tt_bwc_term_left', label: 'BWC contract term left', type: 'string', fieldType: 'text' },
  { name: 'tt_bwc_review_date', label: 'BWC contract review date', type: 'date', fieldType: 'date' },
]

const bwcProperties = (contract = {}, allowed = []) => {
  if (!contract.status) return {}
  const all = {
    tt_bwc_contract: contract.status === 'none' ? 'No contract' : 'Under contract',
    tt_bwc_vendor: contract.status === 'none' ? '' : contract.vendor || '',
    tt_bwc_term_left: contract.status === 'none' ? '' : BWC_TERM_LABELS[contract.termLeft] || '',
    tt_bwc_review_date:
      contract.status === 'under_contract' && contract.reviewAt ? new Date(contract.reviewAt).toISOString().slice(0, 10) : '',
  }
  return Object.fromEntries(allowed.filter((name) => name in all).map((name) => [name, all[name]]))
}

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

/**
 * `person` is who the SDR spoke to on the call being saved - used only when
 * the agency has no chief on file, so there is always a contact to hang the
 * company's calls, reminder and deal on.
 *
 * `ownerEmail` is whoever saved the call: the company and contact are handed
 * to them, every save - the agency belongs to whoever worked it last. Someone
 * who is not a HubSpot user leaves the owners as they are rather than
 * clearing them.
 */
export async function syncAgencyToHubSpot(ori, { person = null, ownerEmail = '' } = {}) {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() })
    .select('ori agencyName state county contacts crm sdr bwcContract surveillance.bwc employment.swornOfficers')
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
  const allowedBwc = agency.bwcContract?.status ? await ensureProperties('companies', BWC_PROPERTY_GROUP, BWC_PROPERTIES) : []

  const ownerId = await ownerIdFor(ownerEmail)
  const owned = ownerId ? { hubspot_owner_id: ownerId } : {}

  companyId = await upsertRecord(
    'companies',
    {
      name: agency.agencyName,
      ...owned,
      ...(domain ? { domain } : {}),
      ...(contacts.website ? { website: contacts.website } : {}),
      ...(contacts.phone ? { phone: contacts.phone } : {}),
      ...(address.line1 ? { address: address.line1 } : {}),
      ...(address.city ? { city: address.city } : {}),
      ...(agency.state ? { state: agency.state } : {}),
      ...(address.zip ? { zip: address.zip } : {}),
      description: mergeDescription(existing.description, qualificationBlock(agency, agency.sdr || {})),
      ...sdrProperties(agency, agency.sdr || {}, allowed),
      ...bwcProperties(agency.bwcContract, allowedBwc),
    },
    companyId,
  )

  // Every agency gets a contact. The chief when one is on file; otherwise,
  // for a first sync, whoever the SDR spoke to, and failing that the
  // agency's main line - so the company always has somebody to call, and a
  // later chief lookup fills the same record in rather than adding one.
  let contactId = agency.crm?.hubspotContactId || ''
  const hasPerson = Boolean(firstname || contacts.email)
  if (!hasPerson && !contactId) {
    const spoke = splitName(person?.name)
    contactId = await upsertRecord('contacts', {
      firstname: spoke.firstname || 'Main line',
      lastname: spoke.firstname ? spoke.lastname : agency.agencyName,
      ...(person?.title ? { jobtitle: person.title } : {}),
      ...(person?.phone || contacts.phone ? { phone: person?.phone || contacts.phone } : {}),
      ...(agency.agencyName ? { company: agency.agencyName } : {}),
      ...owned,
    })
  } else if (contactId && !hasPerson && ownerId) {
    await upsertRecord('contacts', owned, contactId)
  }
  if (contactId && !hasPerson) {
    try {
      await associate('contacts', contactId, 'companies', companyId)
    } catch {
      /* both records exist; they can be linked by hand */
    }
  }
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
        ...owned,
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
  // Only a qualification has anything to say on the timeline; a save that
  // only recorded the camera contract leaves the note alone.
  let noteId = agency.crm?.hubspotSdrNoteId || ''
  const sdrAnswered = ['timeline', 'money', 'authority', 'needs', 'pain', 'notes'].some((key) => agency.sdr?.[key])
  if (sdrAnswered) {
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
    contactSkipped: '',
  }
}

// One save can ask for the same owner three times (company, reminder, deal);
// the owner list changes when someone joins HubSpot, not between saves.
let ownersCache = { at: 0, owners: [] }
const OWNERS_TTL_MS = 10 * 60 * 1000

export const ownerIdFor = async (email) => {
  if (!email) return ''
  try {
    if (Date.now() - ownersCache.at > OWNERS_TTL_MS) ownersCache = { at: Date.now(), owners: await listOwners() }
    return findOwnerForEmail(email, ownersCache.owners)?.id || ''
  } catch {
    return ''
  }
}

/**
 * The "their camera contract is up" reminder, as a HubSpot task on the
 * company - the future-prospect call, dated from the term left.
 *
 * One task per agency, updated on a re-save. An agency that turns out to have
 * no contract closes the reminder rather than deleting it, so the history of
 * what was believed stays on the record.
 */
export async function syncBwcReminder(ori, ownerEmail = '') {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() })
    .select('ori agencyName contacts crm bwcContract')
    .lean()
  if (!agency) throw new Error(`No agency with ORI ${ori}`)
  const contract = agency.bwcContract || {}
  let taskId = agency.crm?.hubspotBwcTaskId || ''

  if (contract.status !== 'under_contract' || !contract.reviewAt) {
    if (taskId) {
      await upsertRecord('tasks', { hs_task_status: 'COMPLETED' }, taskId)
      await LeAgency.updateOne({ ori: agency.ori }, { $set: { 'crm.hubspotBwcTaskId': '' } })
    }
    return { taskId: '', closed: Boolean(taskId) }
  }

  const term = BWC_TERM_LABELS[contract.termLeft] || contract.termLeft
  const ownerId = await ownerIdFor(ownerEmail)
  taskId = await upsertRecord(
    'tasks',
    {
      hs_task_subject: `BWC contract renewal - ${agency.agencyName}`,
      hs_task_body: [
        `${agency.agencyName} told us on a call that they are under a body camera contract${
          contract.vendor ? ` with ${contract.vendor}` : ''
        }, with ${term} left.`,
        'Future prospect: call before the contract renews.',
        agency.contacts?.phone ? `Phone: ${agency.contacts.phone}` : '',
        contract.updatedBy ? `Recorded by ${contract.updatedBy}.` : '',
        `ORI ${agency.ori}`,
      ]
        .filter(Boolean)
        .join('\n'),
      hs_timestamp: new Date(contract.reviewAt).toISOString(),
      hs_task_status: 'NOT_STARTED',
      hs_task_type: 'CALL',
      hs_task_priority: 'MEDIUM',
      ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
    },
    taskId,
  )
  const companyId = agency.crm?.hubspotCompanyId
  if (companyId) await associate('tasks', taskId, 'companies', companyId)
  if (agency.crm?.hubspotContactId) await associate('tasks', taskId, 'contacts', agency.crm.hubspotContactId)
  await LeAgency.updateOne({ ori: agency.ori }, { $set: { 'crm.hubspotBwcTaskId': taskId } })
  return { taskId, dueAt: contract.reviewAt }
}

/**
 * Where a new SDR deal starts: HUBSPOT_SDR_DEAL_PIPELINE / _STAGE when set,
 * otherwise "Deal Pipeline" at "Qualified Lead" - a filled TMAN-P is a
 * qualified lead, the first step of the funnel. Matched by name rather than
 * id so a renumbered portal still works; HubSpot's built-in `default` is the
 * portal's "Old Sales Pipeline" and is only the last resort.
 */
const SDR_DEAL_PIPELINE_LABEL = 'Deal Pipeline'
const SDR_DEAL_STAGE_LABEL = 'Qualified Lead'
let pipelineCache = null
export async function sdrDealPlacement() {
  const envPipeline = process.env.HUBSPOT_SDR_DEAL_PIPELINE?.trim()
  const envStage = process.env.HUBSPOT_SDR_DEAL_STAGE?.trim()
  if (envPipeline && envStage) return { pipeline: envPipeline, dealstage: envStage }
  if (!pipelineCache) {
    const result = await call('GET', '/crm/v3/pipelines/deals')
    pipelineCache = result.results || []
  }
  const pipeline =
    pipelineCache.find((p) => p.id === envPipeline) ||
    pipelineCache.find((p) => p.label?.trim().toLowerCase() === SDR_DEAL_PIPELINE_LABEL.toLowerCase()) ||
    pipelineCache.find((p) => p.id === 'default') ||
    pipelineCache[0]
  if (!pipeline) throw new Error('HubSpot has no deal pipeline to put the deal in.')
  const stages = [...(pipeline.stages || [])].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
  const stage =
    stages.find((s) => s.id === envStage) ||
    stages.find((s) => s.label?.trim().toLowerCase() === SDR_DEAL_STAGE_LABEL.toLowerCase()) ||
    stages.find((s) => /qualif/i.test(s.label)) ||
    stages[0]
  if (!stage) throw new Error(`HubSpot pipeline "${pipeline.label}" has no stages.`)
  return { pipeline: pipeline.id, dealstage: stage.id }
}

/**
 * The deal a TMAN-P qualification opens, on the agency's company and contact.
 *
 * Created once. A re-save refreshes its description and links but never its
 * stage: by then a rep may have moved it, and the call log has no business
 * moving it back.
 */
export async function syncSdrDeal(ori, ownerEmail = '') {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() })
    .select('ori agencyName crm sdr bwcContract')
    .lean()
  if (!agency) throw new Error(`No agency with ORI ${ori}`)
  const companyId = agency.crm?.hubspotCompanyId
  if (!companyId) throw new Error('The agency is not in HubSpot yet, so there is no company to put a deal on.')

  const sdr = agency.sdr || {}
  const description = [
    ...QUESTIONS.filter(([key]) => sdr[key]).map(([key, label]) => `${label}: ${sdr[key]}`),
    sdr.notes ? `Notes: ${sdr.notes}` : '',
    bwcContractLine(agency.bwcContract),
    sdr.filledBy ? `Qualified by ${sdr.filledBy}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 5000)

  let dealId = agency.crm?.hubspotDealId || ''
  const ownerId = await ownerIdFor(ownerEmail)
  if (dealId) {
    // Owner follows whoever qualified it last; the stage stays where a rep put it.
    await upsertRecord('deals', { description, ...(ownerId ? { hubspot_owner_id: ownerId } : {}) }, dealId)
  } else {
    const placement = await sdrDealPlacement()
    dealId = await upsertRecord('deals', {
      dealname: `${agency.agencyName} - Body cameras`,
      ...placement,
      description,
      ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
    })
    await LeAgency.updateOne({ ori: agency.ori }, { $set: { 'crm.hubspotDealId': dealId } })
  }
  await associate('deals', dealId, 'companies', companyId)
  if (agency.crm?.hubspotContactId) await associate('deals', dealId, 'contacts', agency.crm.hubspotContactId)
  if (agency.crm?.hubspotSdrNoteId) {
    try {
      await associate('notes', agency.crm.hubspotSdrNoteId, 'deals', dealId)
    } catch {
      /* the deal stands without the note linked */
    }
  }
  return { dealId }
}

/**
 * Hand the agency's existing deal to whoever saved a call, on a save that did
 * not touch TMAN-P (a TMAN-P save does this in syncSdrDeal). Nothing to do
 * without a deal, or for someone who is not a HubSpot user.
 */
export async function assignDealOwner(ori, ownerEmail = '') {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() }).select('crm.hubspotDealId').lean()
  const dealId = agency?.crm?.hubspotDealId
  const ownerId = await ownerIdFor(ownerEmail)
  if (!dealId || !ownerId) return {}
  await upsertRecord('deals', { hubspot_owner_id: ownerId }, dealId)
  return { dealId }
}
