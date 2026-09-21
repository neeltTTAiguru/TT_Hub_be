import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HUBSPOT_DISPOSITIONS,
  buildMapCallProperties,
  buildMapEmailProperties,
  backfillMapCalls,
  dispositionFor,
  findOwnerForEmail,
  mapCallFingerprint,
  mapEntryKind,
  parseLoggedEmail,
  requireLoggedByEmail,
  upsertMapCallRecord,
} from '../src/services/hubspotMapCalls.js'
import LeAgency from '../src/models/LeAgency.js'

const agency = { ori: 'TX1234500', agencyName: 'Example Police Department' }
const entry = {
  _id: '66f000000000000000000001',
  calledAt: new Date('2026-09-10T15:30:00.000Z'),
  contactName: 'Chief Example',
  contactTitle: 'Chief',
  phone: '555-0100',
  outcome: 'Spoke with decision maker',
  notes: 'Asked for pricing.',
  loggedBy: 'Troy@TrustedTechnology.ai',
}

test('Map Call payload is reportable and preserves the authenticated map email', () => {
  const properties = buildMapCallProperties({ agency, entry, ownerId: '90396815' })

  assert.equal(properties.hs_timestamp, '2026-09-10T15:30:00.000Z')
  assert.equal(properties.hs_call_title, 'Map Call - Example Police Department')
  assert.equal(properties.hs_call_direction, 'OUTBOUND')
  assert.equal(properties.hs_call_status, 'COMPLETED')
  assert.equal(properties.hubspot_owner_id, '90396815')
  assert.equal(properties.tt_call_source, 'agency_map')
  assert.equal(properties.tt_logged_by_email, 'troy@trustedtechnology.ai')
  assert.equal(properties.tt_agency_ori, 'TX1234500')
  assert.equal(properties.tt_map_outcome, 'Spoke with decision maker')
  assert.equal(properties.hs_call_disposition, HUBSPOT_DISPOSITIONS.connected)
  assert.match(properties.hs_call_body, /Asked for pricing/)
})

test("every map outcome that was a dial lands on one of HubSpot's own Outcomes", () => {
  assert.equal(dispositionFor('Spoke with gatekeeper'), HUBSPOT_DISPOSITIONS.connected)
  assert.equal(dispositionFor('Not interested'), HUBSPOT_DISPOSITIONS.connected)
  assert.equal(dispositionFor('Left voicemail'), HUBSPOT_DISPOSITIONS.leftVoicemail)
  assert.equal(dispositionFor('No answer'), HUBSPOT_DISPOSITIONS.noAnswer)
  assert.equal(dispositionFor('Wrong number / bad line'), HUBSPOT_DISPOSITIONS.wrongNumber)
  // No outcome, no Outcome - HubSpot shows "unassigned" rather than a guess.
  assert.equal(dispositionFor(''), '')
  assert.equal('hs_call_disposition' in buildMapCallProperties({ agency, entry: { ...entry, outcome: '' } }), false)
})

test('a bookmark is not a call and an email is not a call', () => {
  assert.equal(mapEntryKind({ outcome: 'Call later' }), 'bookmark')
  assert.equal(mapEntryKind({ outcome: 'Follow-up email sent' }), 'email')
  assert.equal(mapEntryKind({ outcome: 'Left voicemail' }), 'call')
  assert.equal(mapEntryKind({ outcome: '' }), 'call')
})

test('a logged follow-up email becomes a HubSpot Email with its subject and recipient', () => {
  const notes = 'To chief@example.gov\nSubject: Following up on my voicemail\n\nHi Chief,\n\nQuick note.'
  assert.deepEqual(parseLoggedEmail(notes), {
    to: 'chief@example.gov',
    subject: 'Following up on my voicemail',
    body: 'Hi Chief,\n\nQuick note.',
  })
  const properties = buildMapEmailProperties({
    agency,
    entry: { ...entry, outcome: 'Follow-up email sent', notes },
    ownerId: '90396815',
  })
  assert.equal(properties.hs_email_direction, 'EMAIL')
  assert.equal(properties.hs_email_status, 'SENT')
  assert.equal(properties.hs_email_subject, 'Following up on my voicemail')
  assert.equal(properties.hs_email_text, 'Hi Chief,\n\nQuick note.')
  assert.deepEqual(JSON.parse(properties.hs_email_headers), {
    from: { email: 'troy@trustedtechnology.ai' },
    to: [{ email: 'chief@example.gov' }],
  })
  assert.equal(properties.tt_email_source, 'agency_map')
  assert.equal(properties.tt_map_call_id, mapCallFingerprint(agency, entry))
})

test('HubSpot owner attribution is an exact case-insensitive email match', () => {
  const owners = [
    { id: '90396815', email: 'troy@trustedtechnology.ai' },
    { id: '93365592', email: 'neil@trustedtechnology.ai' },
  ]

  assert.equal(findOwnerForEmail('TROY@trustedtechnology.ai', owners)?.id, '90396815')
  assert.equal(findOwnerForEmail('unknown@trustedtechnology.ai', owners), null)
})

test('Map Call fingerprint is stable for backfill idempotency', () => {
  const first = mapCallFingerprint(agency, entry)
  const second = mapCallFingerprint(agency, { ...entry, notes: 'Corrected notes.' })

  assert.equal(first, 'agency-map:TX1234500:66f000000000000000000001')
  assert.equal(second, first)
})

test('agency call entries persist HubSpot id and synchronization errors', () => {
  const callPath = LeAgency.schema.path('callLog').schema
  assert.ok(callPath.path('clientCallId'))
  assert.ok(callPath.path('hubspotCallId'))
  assert.ok(callPath.path('hubspotSyncedAt'))
  assert.ok(callPath.path('hubspotSyncError'))
})

test('backfill processes every historical Map call and keeps going after one failure', async () => {
  const agencies = [
    { ori: 'A', callLog: [{ _id: '1' }, { _id: '2' }], saveCalls: 0, async save() { this.saveCalls += 1 } },
    { ori: 'B', callLog: [{ _id: '3' }], saveCalls: 0, async save() { this.saveCalls += 1 } },
  ]
  const result = await backfillMapCalls(agencies, async (_agency, call) => {
    if (call._id === '2') throw new Error('temporary outage')
    return { callId: `hs-${call._id}` }
  })

  assert.deepEqual(result, { total: 3, synced: 2, skipped: 0, failed: 1 })
  assert.equal(agencies[0].callLog[0].hubspotCallId, 'hs-1')
  assert.match(agencies[0].callLog[1].hubspotSyncError, /temporary outage/)
  assert.equal(agencies[1].callLog[0].hubspotCallId, 'hs-3')
})

test('backfill leaves bookmarks alone rather than sending them up as calls', async () => {
  const agencies = [{ ori: 'A', callLog: [{ _id: '1', outcome: 'Call later' }, { _id: '2' }], async save() {} }]
  const sent = []
  const result = await backfillMapCalls(agencies, async (_agency, call) => {
    if (call.outcome === 'Call later') return null
    sent.push(call._id)
    return { callId: `hs-${call._id}` }
  })
  assert.deepEqual(result, { total: 2, synced: 1, skipped: 1, failed: 0 })
  assert.deepEqual(sent, ['2'])
  assert.equal(agencies[0].callLog[0].hubspotCallId, undefined)
})

test('an Auth0 subject cannot create an unattributed HubSpot Map Call', () => {
  assert.throws(() => requireLoggedByEmail('auth0|abc123'), /authenticated email/i)
  assert.equal(requireLoggedByEmail('Troy@TrustedTechnology.ai'), 'troy@trustedtechnology.ai')
})

test('a missing local ID uses an atomic unique-property upsert instead of search then create', async () => {
  const calls = []
  const callId = await upsertMapCallRecord(agency, entry, { test: 'value' }, {
    upsertRecord: async (type, properties, existingId) => {
      calls.push(['upsert', type, properties, existingId])
      return existingId
    },
    upsertRecordByUniqueProperty: async (type, property, value, properties) => {
      calls.push(['unique-upsert', type, property, value, properties])
      return 'existing-hs-call'
    },
  })

  assert.equal(callId, 'existing-hs-call')
  assert.deepEqual(calls, [[
    'unique-upsert',
    'calls',
    'tt_map_call_id',
    mapCallFingerprint(agency, entry),
    { test: 'value' },
  ]])
})
