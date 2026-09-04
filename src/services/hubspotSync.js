/**
 * Push an agency into HubSpot as a company, and its chief as a contact.
 *
 * This is the hub's first write path to HubSpot. Everything before it read
 * from HubSpot and wrote into Mongo, so nothing here can assume the shape of
 * the write tool is already known-good.
 *
 * Two rules follow from that:
 *
 *   1. Never guess the tool's arguments. The parameter names are read from the
 *      tool's own advertised schema, because a wrong shape against a live CRM
 *      either errors or - worse - creates malformed records a person has to
 *      find and delete by hand.
 *   2. Never let this fail the thing that called it. An SDR's qualification is
 *      the valuable artefact; the sync is a convenience. A HubSpot outage must
 *      not lose someone's typing.
 */
import LeAgency from '../models/LeAgency.js'
import { listHubSpotTools, withHubSpotSession } from './hubspotMcp.js'

/** Resolved once per process - the schema does not change under us mid-run. */
let writeToolPromise = null

const firstPresent = (keys, ...candidates) => candidates.find((name) => keys.includes(name))

/**
 * Work out how to call the create/update tool from what it says about itself.
 *
 * HubSpot names this `manage_crm_objects` and it both creates and updates -
 * passing a record id patches, omitting it creates - which is exactly the
 * behaviour needed to avoid duplicating the 45 agencies already in the pipeline.
 */
async function resolveWriteTool() {
  const tools = await listHubSpotTools()
  const tool =
    tools.find((item) => item.name === 'manage_crm_objects') ||
    tools.find((item) => /^(manage|upsert|create|update)_crm_object/.test(item.name))

  if (!tool) {
    const names = tools.map((item) => item.name).join(', ')
    throw new Error(
      `The HubSpot MCP exposes no create/update tool. Available: ${names || 'none'}.`,
    )
  }

  const keys = Object.keys(tool.inputSchema?.properties || {})
  const resolved = {
    name: tool.name,
    objectTypeKey: firstPresent(keys, 'objectType', 'object_type', 'objectTypeId'),
    idKey: firstPresent(keys, 'objectId', 'recordId', 'record_id', 'id', 'hs_object_id'),
    propertiesKey: firstPresent(keys, 'properties', 'props', 'inputProperties'),
    associationsKey: firstPresent(keys, 'associations', 'associationsToCreate'),
    keys,
  }
  if (!resolved.objectTypeKey || !resolved.propertiesKey) {
    throw new Error(
      `Cannot map ${tool.name}: expected an object-type and properties argument, got [${keys.join(', ')}].`,
    )
  }
  return resolved
}

const writeTool = () => {
  if (!writeToolPromise) {
    writeToolPromise = resolveWriteTool().catch((error) => {
      writeToolPromise = null // so a transient failure does not poison the process
      throw error
    })
  }
  return writeToolPromise
}

/** A company domain, which HubSpot dedupes on far more reliably than a name. */
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
 * Split a published name into HubSpot's first/last.
 *
 * Deliberately crude. These arrive as "Dustin Breshears" or "Erasmo Alarcon
 * Jr." and the only thing that matters is that the contact is findable by a
 * human; inventing a name parser for suffixes and double-barrelled surnames
 * would be a lot of code to get a middle initial in the right box.
 */
const splitName = (full) => {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { firstname: '', lastname: '' }
  if (parts.length === 1) return { firstname: parts[0], lastname: '' }
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') }
}

const findExisting = async (call, objectType, filters, properties = []) => {
  const result = await call('search_crm_objects', {
    objectType,
    properties: ['name', 'domain', 'email', 'firstname', 'lastname', ...properties],
    filterGroups: [{ filters }],
    limit: 1,
  })
  const hit = (result.results || [])[0]
  return { id: hit?.id ? String(hit.id) : '', properties: hit?.properties || {} }
}

// A fenced block we own inside HubSpot's standard `description` field.
//
// Qualification has to be readable on the record itself, not only in our
// database - a rep opening the company in HubSpot should see it. Custom
// properties would be tidier but must exist in the portal first, and
// description is the one rich standard field every company already has.
//
// The fence exists so a re-save replaces our block and leaves anything a
// human wrote alone. Blindly setting description would delete their notes on
// every save.
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
    // The quote is the evidence itself, and the most useful line here: it is
    // the difference between "our tool says yes" and a sentence a rep can read
    // out on a call.
    bwc.summary ? `Evidence: "${bwc.summary}"` : '',
    bwc.evidenceUrl ? `Source: ${bwc.evidenceUrl}` : '',
    bwc.contractEnd
      ? `Contract ends: ${new Date(bwc.contractEnd).toISOString().slice(0, 10)}`
      : '',
    agency.county ? `County: ${agency.county}` : '',
    agency.employment?.swornOfficers ? `Sworn officers: ${agency.employment.swornOfficers}` : '',
    // The join key back to the hub. Without it, matching a HubSpot company to
    // an agency relies on name or domain, which is exactly the fuzzy matching
    // the ORI exists to avoid.
    agency.ori ? `ORI: ${agency.ori}` : '',
    // Named officers the leadership research found beyond the chief. They are
    // more decision makers, and they were otherwise being dropped entirely.
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

/** Swap our block in, preserving whatever a person wrote around it. */
const mergeDescription = (existing, block) => {
  const current = String(existing || '')
  const start = current.indexOf(BLOCK_START)
  if (start === -1) return current ? `${current.trimEnd()}\n\n${block}` : block
  const endMarker = current.indexOf(BLOCK_END, start)
  const end = endMarker === -1 ? current.length : endMarker + BLOCK_END.length
  return (current.slice(0, start) + block + current.slice(end)).trim()
}

const upsert = async (call, tool, objectType, properties, existingId) => {
  const args = { [tool.objectTypeKey]: objectType, [tool.propertiesKey]: properties }
  if (existingId && tool.idKey) args[tool.idKey] = existingId
  const result = await call(tool.name, args)
  return String(result?.id || result?.objectId || existingId || '')
}

/**
 * Create or update the company and its chief, and remember the ids.
 *
 * Storing the ids back is what makes a second save an update rather than a
 * twin: without them, every re-save of a qualification would leave another
 * copy of the agency in HubSpot.
 */
export async function syncAgencyToHubSpot(ori) {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() })
    .select('ori agencyName state county contacts crm sdr surveillance.bwc employment.swornOfficers')
    .lean()
  if (!agency) throw new Error(`No agency with ORI ${ori}`)

  const tool = await writeTool()
  const contacts = agency.contacts || {}
  const address = contacts.streetAddress || {}
  const domain = domainOf(contacts.website)

  return withHubSpotSession(async (call) => {
    // Company first: the contact needs something to belong to.
    let companyId = agency.crm?.hubspotCompanyId || ''
    const found = await findExisting(
      call,
      'companies',
      companyId
        ? [{ propertyName: 'hs_object_id', operator: 'EQ', value: companyId }]
        : domain
          ? [{ propertyName: 'domain', operator: 'EQ', value: domain }]
          : [{ propertyName: 'name', operator: 'EQ', value: agency.agencyName }],
      ['description'],
    )
    companyId = companyId || found.id
    const existingDescription = found.properties.description || ''

    const companyProps = {
      name: agency.agencyName,
      ...(domain ? { domain } : {}),
      ...(contacts.website ? { website: contacts.website } : {}),
      ...(contacts.phone ? { phone: contacts.phone } : {}),
      ...(address.line1 ? { address: address.line1 } : {}),
      ...(address.city ? { city: address.city } : {}),
      ...(agency.state ? { state: agency.state } : {}),
      ...(address.zip ? { zip: address.zip } : {}),
      description: mergeDescription(existingDescription, qualificationBlock(agency, agency.sdr || {})),
    }
    companyId = await upsert(call, tool, 'companies', companyProps, companyId)

    // Contact only when there is a person to create. A nameless, emailless
    // contact is a row nobody can act on and another thing to deduplicate.
    let contactId = agency.crm?.hubspotContactId || ''
    const { firstname, lastname } = splitName(contacts.chiefName)
    const hasPerson = Boolean(firstname || contacts.email)

    if (hasPerson) {
      if (!contactId && contacts.email) {
        contactId = (
          await findExisting(call, 'contacts', [
            { propertyName: 'email', operator: 'EQ', value: contacts.email },
          ])
        ).id
      }
      const contactProps = {
        ...(firstname ? { firstname } : {}),
        ...(lastname ? { lastname } : {}),
        ...(contacts.email ? { email: contacts.email } : {}),
        ...(contacts.phone ? { phone: contacts.phone } : {}),
        ...(contacts.chiefTitle ? { jobtitle: contacts.chiefTitle } : {}),
        ...(agency.agencyName ? { company: agency.agencyName } : {}),
      }
      const args = { [tool.objectTypeKey]: 'contacts', [tool.propertiesKey]: contactProps }
      if (contactId && tool.idKey) args[tool.idKey] = contactId
      // Associate on create where the tool supports it. If it does not, the
      // contact still carries the company name and can be linked by hand -
      // better than failing the whole sync over a link.
      if (tool.associationsKey && companyId && !contactId) {
        args[tool.associationsKey] = [{ to: { id: companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 }] }]
      }
      const result = await call(tool.name, args)
      contactId = String(result?.id || result?.objectId || contactId || '')
    }

    await LeAgency.updateOne(
      { ori: agency.ori },
      {
        $set: {
          'crm.hubspotCompanyId': companyId,
          'crm.hubspotContactId': contactId,
          'crm.hubspotSyncedAt': new Date(),
          'crm.hubspotSyncError': '',
        },
      },
    )

    return {
      companyId,
      contactId,
      contactSkipped: hasPerson ? '' : 'No chief name or email on file, so no contact was created.',
      tool: tool.name,
    }
  })
}
