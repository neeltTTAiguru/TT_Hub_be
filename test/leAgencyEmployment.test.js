import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEmployment } from '../src/services/leAgencyEmployment.js'

// Captured from api.usa.gov/crime/fbi/cde/pe/agency/RI0020100 (Coventry PD, RI).
const coventryPayload = {
  rates: {
    'Law Enforcement Employees per 1,000 People': {
      2020: 2.33, 2021: 1.99, 2022: 1.79, 2023: 1.75, 2024: 1.68,
    },
  },
  actuals: {
    'Male Officers': { 2020: 53, 2021: 53, 2022: 47, 2023: 45, 2024: 43 },
    'Male Civilians': { 2020: 5, 2021: 5, 2022: 5, 2023: 4, 2024: 5 },
    'Female Officers': { 2020: 4, 2021: 4, 2022: 4, 2023: 5, 2024: 5 },
    'Female Civilians': { 2020: 19, 2021: 10, 2022: 8, 2023: 9, 2024: 8 },
  },
}

test('sworn officer count sums male and female officers, excluding civilians', () => {
  const rows = parseEmployment(coventryPayload)
  const latest = rows[rows.length - 1]

  assert.equal(latest.year, 2024)
  assert.equal(latest.swornOfficers, 48)
  assert.equal(latest.civilians, 13)
  assert.equal(latest.totalEmployees, 61)
  assert.equal(latest.employeesPer1000, 1.68)
})

test('rows come back sorted oldest to newest so the last row is current', () => {
  const rows = parseEmployment(coventryPayload)
  assert.deepEqual(rows.map((r) => r.year), [2020, 2021, 2022, 2023, 2024])
  assert.equal(rows[0].swornOfficers, 57)
})

test('an agency that stopped reporting is absent, not a zero-officer department', () => {
  const rows = parseEmployment({
    actuals: {
      'Male Officers': { 2023: 12, 2024: 0 },
      'Female Officers': { 2023: 2, 2024: 0 },
      'Male Civilians': { 2023: 1, 2024: 0 },
      'Female Civilians': { 2023: 1, 2024: 0 },
    },
  })

  assert.deepEqual(rows.map((r) => r.year), [2023])
  assert.equal(rows[0].swornOfficers, 14)
})

test('a civilian-only agency still records zero sworn officers', () => {
  const rows = parseEmployment({
    actuals: {
      'Male Officers': { 2024: 0 },
      'Female Officers': { 2024: 0 },
      'Male Civilians': { 2024: 6 },
      'Female Civilians': { 2024: 4 },
    },
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].swornOfficers, 0)
  assert.equal(rows[0].civilians, 10)
})

test('agencies with no employment data return no rows', () => {
  assert.deepEqual(parseEmployment(null), [])
  assert.deepEqual(parseEmployment({}), [])
  assert.deepEqual(parseEmployment({ actuals: {} }), [])
})
