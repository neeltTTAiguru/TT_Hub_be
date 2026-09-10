import test from 'node:test'
import assert from 'node:assert/strict'
import { PDFParse } from 'pdf-parse'
import { resolvePeriod, safeZone } from '../src/services/callReport.js'
import { createCallReportPdfBuffer } from '../src/services/callReportPdf.js'

test('a bare date range covers whole days in the reader timezone, not the server one', () => {
  const period = resolvePeriod({ from: '2026-09-08', to: '2026-09-10', timezone: 'America/Chicago' })

  // Midnight in Texas, not midnight UTC. Read with the server's clock instead,
  // the window closed at 07:00 UTC and every call made after lunch on the last
  // day - the report somebody runs at four in the afternoon - fell outside it.
  assert.equal(period.from.toISOString(), '2026-09-08T05:00:00.000Z')
  assert.equal(period.to.toISOString(), '2026-09-11T04:59:59.999Z')
})

test('the window is right across a daylight saving change', () => {
  // US clocks go forward on 8 March 2026, so the second day is 23 hours long.
  const period = resolvePeriod({ from: '2026-03-07', to: '2026-03-08', timezone: 'America/Chicago' })

  assert.equal(period.from.toISOString(), '2026-03-07T06:00:00.000Z')
  assert.equal(period.to.toISOString(), '2026-03-09T04:59:59.999Z')
})

test('an ISO instant is taken as given, and a nonsense zone falls back to UTC', () => {
  const period = resolvePeriod({
    from: '2026-09-08T13:30:00.000Z',
    to: '2026-09-08T17:00:00.000Z',
    timezone: 'Mars/Olympus',
  })

  assert.equal(period.from.toISOString(), '2026-09-08T13:30:00.000Z')
  assert.equal(period.to.toISOString(), '2026-09-08T17:00:00.000Z')
  assert.equal(period.timezone, 'UTC')
  assert.equal(safeZone(''), 'UTC')
})

const stats = {
  period: { from: '2026-09-08T05:00:00.000Z', to: '2026-09-11T04:59:59.999Z', days: 3, timezone: 'America/Chicago' },
  totals: {
    calls: 64,
    agenciesCalled: 62,
    agenciesInScope: 1549,
    firstContacts: 62,
    reps: 2,
    conversations: 33,
    decisionMakers: 4,
    followUps: 1,
    days: 3,
    callsPerDay: 21.3,
    connectRate: 52,
  },
  byOutcome: [
    { outcome: 'Spoke with gatekeeper', calls: 29, agencies: 29 },
    { outcome: 'Left voicemail', calls: 26, agencies: 26 },
  ],
  byDay: [
    { date: '2026-09-08', calls: 1, agencies: 1, conversations: 1 },
    { date: '2026-09-09', calls: 33, agencies: 33, conversations: 19 },
    { date: '2026-09-10', calls: 30, agencies: 28, conversations: 13 },
  ],
  byState: [{ state: 'TX', calls: 64, agencies: 62, conversations: 33 }],
  byRep: [{ rep: 'kyle@trustedtechnology.ai', calls: 52, agencies: 50, conversations: 26, decisionMakers: 3 }],
  topAgencies: [
    {
      ori: 'TX0900400',
      name: "Gray County Constable: Precinct 1",
      state: 'TX',
      county: 'GRAY',
      calls: 1,
      conversations: 1,
      lastCalledAt: '2026-09-09T19:03:00.000Z',
    },
  ],
  followUps: [
    {
      ori: 'TX0350000',
      name: "Castro County Sheriff's Office",
      state: 'TX',
      followUpAt: '2026-09-15T00:00:00.000Z',
      outcome: 'Call back scheduled',
      contactName: 'Sheriff Davis',
      loggedBy: 'kyle@trustedtechnology.ai',
    },
  ],
}

const textOf = async (buffer) => (await new PDFParse({ data: buffer }).getText()).text

test('the report prints the counted figures and the summary Hermes wrote', async () => {
  const pdf = await createCallReportPdfBuffer(stats, {
    scopeLabel: 'States: TX; Officers: any to 100',
    // The curly quotes are the point: Helvetica is WinAnsi-encoded, and a note
    // pasted out of an email is full of them.
    narrative: '## Summary\n\nThey called the cameras “absolute junk”.\n\n- Ring Castro County back.',
    generatedBy: 'kyle@trustedtechnology.ai',
  })
  const text = await textOf(pdf)

  assert.match(text, /Call activity report/)
  assert.match(text, /8 - 10 September 2026/)
  assert.match(text, /States: TX; Officers: any to 100/)
  assert.match(text, /64/)
  assert.match(text, /Spoke with gatekeeper/)
  assert.match(text, /Ring Castro County back/)
  assert.match(text, /"absolute junk"/)
  assert.doesNotMatch(text, /[“”]/)
  assert.match(text, /Castro County Sheriff's Office/)
})

test('losing Hermes costs the summary, not the report', async () => {
  const pdf = await createCallReportPdfBuffer(stats, {
    scopeLabel: 'All states',
    narrativeError: 'Hermes took too long to respond.',
  })
  const text = await textOf(pdf)

  assert.match(text, /could not be produced/)
  assert.match(text, /Hermes took too long to respond/)
  // The figures are counted before Hermes is asked for anything, so they are
  // all still here.
  assert.match(text, /Who made the calls/)
  assert.match(text, /kyle@trustedtechnology\.ai/)
})

test('a period with no calls says so instead of printing empty tables', async () => {
  const pdf = await createCallReportPdfBuffer(
    {
      period: stats.period,
      totals: { calls: 0, agenciesCalled: 0, agenciesInScope: 1549, days: 3, connectRate: 0, callsPerDay: 0 },
      byOutcome: [],
      byDay: [],
      byState: [],
      byRep: [],
      topAgencies: [],
      followUps: [],
    },
    { scopeLabel: 'States: CA' },
  )
  const text = await textOf(pdf)

  assert.match(text, /No calls in this period/)
  assert.doesNotMatch(text, /How the calls went/)
})
