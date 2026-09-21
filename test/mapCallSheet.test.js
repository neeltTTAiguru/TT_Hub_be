import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAP_CALL_SHEET_PIPELINE,
  buildSheetQuery,
  csvCell,
  mapCallsToCsv,
} from '../src/services/mapCallSheet.js'

test('the sheet is one row per call, keyed by the call, and leaves test agencies out', () => {
  const [match, unwind, project] = MAP_CALL_SHEET_PIPELINE
  assert.deepEqual(match.$match.isTestRecord, { $ne: true })
  assert.equal(unwind.$unwind, '$callLog')
  assert.equal(project.$project._id, '$callLog._id')
  assert.equal(project.$project.loggedBy, '$callLog.loggedBy')
  assert.equal(project.$project.hubspotCallId, '$callLog.hubspotCallId')
})

test('a rep and a bare-date window filter the sheet the way the call report reads them', () => {
  const { match, period } = buildSheetQuery({
    rep: ' Troy.Broddrick@TrustedTechnology.ai ',
    from: '2026-09-14',
    to: '2026-09-20',
    timezone: 'America/Chicago',
  })
  assert.equal(match.loggedBy, 'troy.broddrick@trustedtechnology.ai')
  // Midnight on the 14th in Chicago is 05:00 UTC; the 20th ends a second before 05:00 UTC on the 21st.
  assert.equal(period.from.toISOString(), '2026-09-14T05:00:00.000Z')
  assert.equal(period.to.toISOString(), '2026-09-21T04:59:59.999Z')
  assert.deepEqual(match.calledAt, { $gte: period.from, $lte: period.to })
})

test('several reps, outcomes and kinds become $in clauses; unknown kinds are ignored', () => {
  const { match } = buildSheetQuery({
    rep: 'troy@x.ai,neil@x.ai',
    outcome: ['Left voicemail', 'Spoke with gatekeeper'],
    kind: 'call,email,nonsense',
    unsynced: 'true',
  })
  assert.deepEqual(match.loggedBy, { $in: ['troy@x.ai', 'neil@x.ai'] })
  assert.deepEqual(match.outcome, { $in: ['Left voicemail', 'Spoke with gatekeeper'] })
  assert.deepEqual(match.kind, { $in: ['call', 'email'] })
  assert.deepEqual(match.hubspotCallId, { $in: ['', null] })
})

test('CSV quotes commas, quotes and newlines so notes survive a spreadsheet import', () => {
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('said "no", call back\nnext week'), '"said ""no"", call back\nnext week"')
  const csv = mapCallsToCsv([
    {
      _id: '66f000000000000000000001',
      calledOn: '2026-09-15',
      calledAt: new Date('2026-09-15T15:30:00.000Z'),
      loggedBy: 'troy.broddrick@trustedtechnology.ai',
      agencyName: 'Example Police Department',
      state: 'TX',
      ori: 'TX1234500',
      kind: 'call',
      outcome: 'Spoke with decision maker',
      notes: 'Asked for pricing, wants a demo',
      swornOfficers: 18,
      hubspotCallId: '12345',
    },
  ])
  const [header, row] = csv.split('\r\n')
  assert.match(header, /^Date,Called at \(UTC\),Rep,Agency,State,ORI,Type,Outcome/)
  assert.match(row, /^2026-09-15,2026-09-15T15:30:00.000Z,troy.broddrick@trustedtechnology.ai,Example Police Department,TX,TX1234500,call,Spoke with decision maker,/)
  assert.match(row, /"Asked for pricing, wants a demo",18,,12345,,,66f000000000000000000001$/)
})
