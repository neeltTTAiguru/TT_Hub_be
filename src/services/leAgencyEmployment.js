/**
 * Parses the FBI CDE police employment (PE) payload into per-year rows.
 *
 * The API nests counts as:
 *   { actuals: { "Male Officers": { "2024": 43 }, "Female Officers": { "2024": 5 } },
 *     rates:   { "Law Enforcement Employees per 1,000 People": { "2024": 1.68 } } }
 *
 * Sworn officer count is male + female officers. Civilians are reported
 * separately and are not part of the officer headcount agencies are sized by.
 */
export const parseEmployment = (payload) => {
  const actuals = payload?.actuals
  if (!actuals || typeof actuals !== 'object') return []

  const rates = payload?.rates?.['Law Enforcement Employees per 1,000 People'] || {}
  const pick = (label) => actuals[label] || {}

  const maleOfficers = pick('Male Officers')
  const femaleOfficers = pick('Female Officers')
  const maleCivilians = pick('Male Civilians')
  const femaleCivilians = pick('Female Civilians')

  const years = new Set([
    ...Object.keys(maleOfficers),
    ...Object.keys(femaleOfficers),
    ...Object.keys(maleCivilians),
    ...Object.keys(femaleCivilians),
  ])

  const num = (source, year) => {
    const value = Number(source?.[year])
    return Number.isFinite(value) ? value : null
  }

  const rows = []
  for (const yearKey of years) {
    const year = Number(yearKey)
    if (!Number.isFinite(year)) continue

    const male = num(maleOfficers, yearKey)
    const female = num(femaleOfficers, yearKey)
    const civMale = num(maleCivilians, yearKey)
    const civFemale = num(femaleCivilians, yearKey)

    const swornOfficers =
      male === null && female === null ? null : (male || 0) + (female || 0)
    const civilians =
      civMale === null && civFemale === null ? null : (civMale || 0) + (civFemale || 0)

    if (swornOfficers === null && civilians === null) continue
    // An agency that stopped reporting shows an all-zero year. Recording that as
    // "0 officers" would put defunct records at the top of every small-agency
    // query, so treat it as absent data instead.
    if (swornOfficers === 0 && (civilians === null || civilians === 0)) continue

    rows.push({
      year,
      swornOfficers,
      maleOfficers: male,
      femaleOfficers: female,
      civilians,
      totalEmployees:
        swornOfficers === null && civilians === null
          ? null
          : (swornOfficers || 0) + (civilians || 0),
      employeesPer1000: num(rates, yearKey),
    })
  }

  return rows.sort((a, b) => a.year - b.year)
}

export default parseEmployment
