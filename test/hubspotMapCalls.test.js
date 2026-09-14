import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMapCallProperties,
  backfillMapCalls,
  findOwnerForEmail,
  mapCallFingerprint,
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
  assert.match(properties.hs_call_body, /Asked for pricing/)
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

  assert.deepEqual(result, { total: 3, synced: 2, failed: 1 })
  assert.equal(agencies[0].callLog[0].hubspotCallId, 'hs-1')
  assert.match(agencies[0].callLog[1].hubspotSyncError, /temporary outage/)
  assert.equal(agencies[1].callLog[0].hubspotCallId, 'hs-3')
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
