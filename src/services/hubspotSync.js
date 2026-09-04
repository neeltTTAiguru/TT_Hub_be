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
import { associate, findRecord, readRecord, upsertRecord } from './hubspotRest.js'

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

  await LeAgency.updateOne(
    { ori: agency.ori },
    {
      $set: {
        'crm.hubspotCompanyId': companyId,
        ...(contactId ? { 'crm.hubspotContactId': contactId } : {}),
        'crm.hubspotSyncedAt': new Date(),
        'crm.hubspotSyncError': '',
      },
    },
  )

  return {
    companyId,
    contactId,
    contactSkipped: hasPerson ? '' : 'No chief name or email on file, so no contact was created.',
  }
}
