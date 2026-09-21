import test from 'node:test'
import assert from 'node:assert/strict'
import { miniRunPick } from '../src/services/dailyResearch.js'

const schedule = { pick: { states: [], agencyTypes: [], maxOfficers: 25, camera: 'unknown' } }

test("a mini run draws from the person's own map scope, field by field", () => {
  const neil = { scope: { states: ['TX'], agencyTypes: [], maxOfficers: null, camera: 'not_yes' } }
  assert.deepEqual(miniRunPick(schedule, neil), {
    states: ['TX'],
    agencyTypes: [],
    maxOfficers: 25, // no ceiling of their own, so the morning's
    camera: 'unknown', // never theirs to choose
  })
})

test('no scope at all means the morning pick', () => {
  assert.deepEqual(miniRunPick(schedule, { scope: {} }), { ...schedule.pick, camera: 'unknown' })
  assert.deepEqual(miniRunPick(schedule, null), { ...schedule.pick, camera: 'unknown' })
})

test('a size ceiling of their own beats the morning one', () => {
  const kyle = { scope: { states: ['TX'], agencyTypes: ['Municipal'], maxOfficers: 10, camera: 'any' } }
  assert.deepEqual(miniRunPick(schedule, kyle), { states: ['TX'], agencyTypes: ['Municipal'], maxOfficers: 10, camera: 'unknown' })
})

test('a board-started run emails like the morning, minus the overnight wording', async () => {
  const { buildLeadsEmail } = await import('../src/services/dailyResearch.js')
  const rows = [
    { agency: 'Example PD', county: 'TRAVIS', state: 'TX', cameras: 'Unknown', chief: 'Chief A', phone: '555-0100', email: '' },
    { agency: 'Other SO', county: 'HAYS', state: 'TX', cameras: 'Yes', chief: '', phone: '', email: '' },
  ]
  const from = { name: 'Neel Palle', email: 'neel@trustedtechnology.ai' }
  const mini = buildLeadsEmail({ rows, to: { name: 'Neil' }, entry: { email: 'neil@x.ai' }, day: { date: '2026-09-21' }, from, kind: 'mini' })
  assert.equal(mini.subject, '1 new leads on your map - 2026-09-21')
  assert.match(mini.text, /researched 2 agencies for you just now/)
  assert.match(mini.text, /Example PD \(Travis County, TX\)/)
  assert.doesNotMatch(mini.text, /overnight/)
  const morning = buildLeadsEmail({ rows, to: { name: 'Neil' }, entry: { email: 'neil@x.ai' }, day: { date: '2026-09-21' }, from })
  assert.match(morning.text, /overnight/)
  assert.equal(morning.subject, '1 new leads on your map - 2026-09-21')
})
