import {
  associate,
  ensureProperties,
  listOwners,
  requireUniqueProperty,
  upsertRecord,
  upsertRecordByUniqueProperty,
} from './hubspotRest.js'

const MAP_CALL_GROUP = { name: 'trusted_tech_map_calls', label: 'Trusted Tech Map Calls' }
const MAP_CALL_PROPERTIES = [
  { name: 'tt_call_source', label: 'Call source', type: 'enumeration', fieldType: 'select', options: [
    { label: 'Agency Map', value: 'agency_map', displayOrder: 0, hidden: false },
  ] },
  { name: 'tt_logged_by_email', label: 'Map user email', type: 'string', fieldType: 'text' },
  { name: 'tt_agency_ori', label: 'Agency ORI', type: 'string', fieldType: 'text' },
  { name: 'tt_map_outcome', label: 'Map call outcome', type: 'string', fieldType: 'text' },
  {
    name: 'tt_map_call_id',
    label: 'Map call ID',
    type: 'string',
    fieldType: 'text',
    hasUniqueValue: true,
  },
]

const cleanEmail = (value) => String(value || '').trim().toLowerCase()
const clean = (value) => String(value || '').trim()

export function requireLoggedByEmail(value) {
  const email = cleanEmail(value)
  if (!email || !email.includes('@')) {
    throw new Error('Map Call cannot sync without the authenticated email used on the map.')
  }
  return email
}

export function findOwnerForEmail(email, owners = []) {
  const wanted = cleanEmail(email)
  if (!wanted) return null
  return owners.find((owner) => cleanEmail(owner.email) === wanted) || null
}

export function mapCallFingerprint(agency, entry) {
  return `agency-map:${clean(agency?.ori).toUpperCase()}:${clean(entry?._id)}`
}

export function buildMapCallProperties({ agency, entry, ownerId = '' }) {
  const email = requireLoggedByEmail(entry?.loggedBy)
  const details = [
    entry?.contactName ? `Contact: ${clean(entry.contactName)}` : '',
    entry?.contactTitle ? `Title: ${clean(entry.contactTitle)}` : '',
    entry?.phone ? `Phone: ${clean(entry.phone)}` : '',
    entry?.outcome ? `Outcome: ${clean(entry.outcome)}` : '',
    entry?.followUpAt ? `Follow-up: ${new Date(entry.followUpAt).toISOString()}` : '',
    entry?.notes ? `Notes: ${clean(entry.notes)}` : '',
    email ? `Logged in Trusted Tech Central by: ${email}` : '',
    agency?.ori ? `ORI: ${clean(agency.ori).toUpperCase()}` : '',
  ].filter(Boolean)

  return {
    hs_timestamp: new Date(entry?.calledAt || entry?.loggedAt || Date.now()).toISOString(),
    hs_call_title: `Map Call - ${clean(agency?.agencyName) || clean(agency?.ori)}`,
    hs_call_body: details.join('\n'),
    hs_call_direction: 'OUTBOUND',
    hs_call_status: 'COMPLETED',
    ...(ownerId ? { hubspot_owner_id: clean(ownerId) } : {}),
    tt_call_source: 'agency_map',
    tt_logged_by_email: email,
    tt_agency_ori: clean(agency?.ori).toUpperCase(),
    tt_map_outcome: clean(entry?.outcome),
    tt_map_call_id: mapCallFingerprint(agency, entry),
  }
}

export async function upsertMapCallRecord(
  agency,
  entry,
  properties,
  api = { upsertRecord, upsertRecordByUniqueProperty },
) {
  const existingId = clean(entry?.hubspotCallId)
  if (existingId) return api.upsertRecord('calls', properties, existingId)
  return api.upsertRecordByUniqueProperty(
    'calls',
    'tt_map_call_id',
    mapCallFingerprint(agency, entry),
    properties,
  )
}

/** Create or update one native HubSpot Call activity for an Agency Map call. */
export async function syncMapCallToHubSpot(agency, entry) {
  requireLoggedByEmail(entry.loggedBy)
  const allowed = await ensureProperties('calls', MAP_CALL_GROUP, MAP_CALL_PROPERTIES)
  if (allowed.length !== MAP_CALL_PROPERTIES.length) {
    throw new Error('HubSpot Map Call properties are unavailable. Grant calls schema write access.')
  }
  await requireUniqueProperty('calls', 'tt_map_call_id')

  const owners = await listOwners()
  const owner = findOwnerForEmail(entry.loggedBy, owners)
  const callId = await upsertMapCallRecord(
    agency,
    entry,
    buildMapCallProperties({ agency, entry, ownerId: owner?.id || '' }),
  )

  const companyId = clean(agency?.crm?.hubspotCompanyId)
  const contactId = clean(agency?.crm?.hubspotContactId)
  if (companyId) await associate('calls', callId, 'companies', companyId)
  if (contactId) await associate('calls', callId, 'contacts', contactId)

  return { callId, ownerId: owner?.id || '', loggedBy: cleanEmail(entry.loggedBy) }
}

/** Resumable historical migration; each call is persisted before moving on. */
export async function backfillMapCalls(agencies, sync = syncMapCallToHubSpot) {
  const stats = { total: 0, synced: 0, failed: 0 }
  for await (const agency of agencies) {
    for (const entry of agency.callLog || []) {
      stats.total += 1
      try {
        const result = await sync(agency, entry)
        entry.hubspotCallId = result.callId
        entry.hubspotSyncedAt = new Date()
        entry.hubspotSyncError = ''
        await agency.save()
        stats.synced += 1
      } catch (error) {
        entry.hubspotSyncError = String(error?.message || error).slice(0, 300)
        stats.failed += 1
        try {
          await agency.save()
        } catch {
          // A retry reconciles the remote Call by tt_map_call_id even if this
          // process could not persist its HubSpot ID or error locally.
        }
      }
    }
  }
  return stats
}
