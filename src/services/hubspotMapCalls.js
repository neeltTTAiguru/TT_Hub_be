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

// The same card on a HubSpot Email, so a follow-up email is traceable to the
// map and to the rep the same way a call is.
const MAP_EMAIL_GROUP = { name: 'trusted_tech_map_emails', label: 'Trusted Tech Map Emails' }
const MAP_EMAIL_PROPERTIES = MAP_CALL_PROPERTIES.map((definition) =>
  definition.name === 'tt_call_source'
    ? { ...definition, name: 'tt_email_source', label: 'Email source' }
    : definition,
)

/**
 * What a log entry is to HubSpot: a Call, an Email, or nothing at all.
 *
 * Every row in an agency's log is a call to the map, but not to HubSpot.
 * "Call later" is the one-click deferral - the SDR looked at the pin and put
 * it off - and syncing it as a completed outbound call inflated a rep's week
 * by a fifth. A follow-up email is real work but it is an Email, and counting
 * it as a call hides the one number a manager asked for: how many voicemails
 * got a follow-up.
 */
export const BOOKMARK_OUTCOME = 'Call later'
export const EMAIL_OUTCOME = 'Follow-up email sent'

export function mapEntryKind(entry) {
  const outcome = clean(entry?.outcome)
  if (outcome === BOOKMARK_OUTCOME) return 'bookmark'
  if (outcome === EMAIL_OUTCOME) return 'email'
  return 'call'
}

/**
 * HubSpot's own Outcome for each of the map's, so a HubSpot report can break
 * calls down without knowing our strings.
 *
 * Every portal ships these seven dispositions with these ids; they are not
 * per-portal. "Connected" means a human answered, whoever it was - the
 * decision-maker/gatekeeper distinction stays in `tt_map_outcome`, which is
 * ours. "Busy", "Left live message" and "Meeting booked" have no map
 * equivalent yet, so nothing maps to them.
 */
export const HUBSPOT_DISPOSITIONS = {
  connected: 'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  leftVoicemail: 'b2cf5968-551e-4856-9783-52b3da59a7d0',
  noAnswer: '73a0d17f-1163-4015-bdd5-ec830791da20',
  wrongNumber: '17b47fee-58de-441e-a44c-c6300d46f273',
}

const DISPOSITION_FOR_OUTCOME = {
  'Spoke with decision maker': HUBSPOT_DISPOSITIONS.connected,
  'Spoke with gatekeeper': HUBSPOT_DISPOSITIONS.connected,
  'Call back scheduled': HUBSPOT_DISPOSITIONS.connected,
  'Asked for information by email': HUBSPOT_DISPOSITIONS.connected,
  'Not interested': HUBSPOT_DISPOSITIONS.connected,
  'Left voicemail': HUBSPOT_DISPOSITIONS.leftVoicemail,
  'No answer': HUBSPOT_DISPOSITIONS.noAnswer,
  'Wrong number / bad line': HUBSPOT_DISPOSITIONS.wrongNumber,
}

export const dispositionFor = (outcome) => DISPOSITION_FOR_OUTCOME[clean(outcome)] || ''

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
  const disposition = dispositionFor(entry?.outcome)

  return {
    hs_timestamp: new Date(entry?.calledAt || entry?.loggedAt || Date.now()).toISOString(),
    hs_call_title: `Map Call - ${clean(agency?.agencyName) || clean(agency?.ori)}`,
    hs_call_body: details.join('\n'),
    hs_call_direction: 'OUTBOUND',
    hs_call_status: 'COMPLETED',
    ...(disposition ? { hs_call_disposition: disposition } : {}),
    ...(ownerId ? { hubspot_owner_id: clean(ownerId) } : {}),
    tt_call_source: 'agency_map',
    tt_logged_by_email: email,
    tt_agency_ori: clean(agency?.ori).toUpperCase(),
    tt_map_outcome: clean(entry?.outcome),
    tt_map_call_id: mapCallFingerprint(agency, entry),
  }
}

/**
 * The email as the map logged it: the notes hold "To <address>", a subject
 * line, a blank line and the body. Pulled back apart here so HubSpot shows a
 * subject and a recipient rather than one block of text.
 */
export function parseLoggedEmail(notes) {
  const lines = String(notes || '').split('\n')
  const to = /^To (.+)$/.exec(lines[0] || '')?.[1]?.trim() || ''
  const subject = /^Subject: (.+)$/.exec(lines[1] || '')?.[1]?.trim() || ''
  const body = (to || subject ? lines.slice(2) : lines).join('\n').replace(/^\n+/, '')
  return { to, subject, body }
}

export function buildMapEmailProperties({ agency, entry, ownerId = '' }) {
  const email = requireLoggedByEmail(entry?.loggedBy)
  const { to, subject, body } = parseLoggedEmail(entry?.notes)
  const headers = { from: { email }, to: to ? [{ email: to }] : [] }
  return {
    hs_timestamp: new Date(entry?.calledAt || entry?.loggedAt || Date.now()).toISOString(),
    hs_email_direction: 'EMAIL',
    hs_email_status: 'SENT',
    hs_email_subject: subject || `Follow-up - ${clean(agency?.agencyName) || clean(agency?.ori)}`,
    hs_email_text: body,
    hs_email_headers: JSON.stringify(headers),
    ...(ownerId ? { hubspot_owner_id: clean(ownerId) } : {}),
    tt_email_source: 'agency_map',
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
  objectType = 'calls',
) {
  const existingId = clean(entry?.hubspotCallId)
  if (existingId) return api.upsertRecord(objectType, properties, existingId)
  return api.upsertRecordByUniqueProperty(
    objectType,
    'tt_map_call_id',
    mapCallFingerprint(agency, entry),
    properties,
  )
}

async function syncEngagement(agency, entry, objectType, group, definitions, build) {
  requireLoggedByEmail(entry.loggedBy)
  const allowed = await ensureProperties(objectType, group, definitions)
  if (allowed.length !== definitions.length) {
    throw new Error(`HubSpot Map ${objectType} properties are unavailable. Grant ${objectType} schema write access.`)
  }
  await requireUniqueProperty(objectType, 'tt_map_call_id')

  const owners = await listOwners()
  const owner = findOwnerForEmail(entry.loggedBy, owners)
  const callId = await upsertMapCallRecord(
    agency,
    entry,
    build({ agency, entry, ownerId: owner?.id || '' }),
    undefined,
    objectType,
  )

  const companyId = clean(agency?.crm?.hubspotCompanyId)
  const contactId = clean(agency?.crm?.hubspotContactId)
  if (companyId) await associate(objectType, callId, 'companies', companyId)
  if (contactId) await associate(objectType, callId, 'contacts', contactId)

  return { callId, ownerId: owner?.id || '', loggedBy: cleanEmail(entry.loggedBy) }
}

/** Create or update one native HubSpot Call activity for an Agency Map call. */
export async function syncMapCallToHubSpot(agency, entry) {
  return syncEngagement(agency, entry, 'calls', MAP_CALL_GROUP, MAP_CALL_PROPERTIES, buildMapCallProperties)
}

/** Create or update one native HubSpot Email activity for a follow-up sent from the map. */
export async function syncMapEmailToHubSpot(agency, entry) {
  return syncEngagement(agency, entry, 'emails', MAP_EMAIL_GROUP, MAP_EMAIL_PROPERTIES, buildMapEmailProperties)
}

/**
 * The one entry point the routes use: the right HubSpot object for the entry,
 * or `null` when there is nothing to send. The stored id is a Call's or an
 * Email's; `hubspotCallId` keeps its name because the map's log is older than
 * the distinction.
 */
export async function syncMapEntryToHubSpot(agency, entry) {
  const kind = mapEntryKind(entry)
  if (kind === 'bookmark') return null
  if (kind === 'email') return syncMapEmailToHubSpot(agency, entry)
  return syncMapCallToHubSpot(agency, entry)
}

/** Resumable historical migration; each entry is persisted before moving on. */
export async function backfillMapCalls(agencies, sync = syncMapEntryToHubSpot) {
  const stats = { total: 0, synced: 0, skipped: 0, failed: 0 }
  for await (const agency of agencies) {
    for (const entry of agency.callLog || []) {
      stats.total += 1
      try {
        const result = await sync(agency, entry)
        if (!result) {
          stats.skipped += 1
          continue
        }
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
          // A retry reconciles the remote record by tt_map_call_id even if this
          // process could not persist its HubSpot ID or error locally.
        }
      }
    }
  }
  return stats
}
