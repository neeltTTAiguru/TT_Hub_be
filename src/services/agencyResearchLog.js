/**
 * Keeps the research log in step with the agency record.
 *
 * One function, called from every path that researches an agency, so the log
 * cannot drift from what the agency actually says: it reads the agency back
 * after the write rather than trusting whatever the caller thinks it found.
 * Logging never throws - a research result that was saved is worth more than
 * a log line, so a failure here is reported and swallowed.
 */
import AgencyResearchLog from '../models/AgencyResearchLog.js'
import LeAgency from '../models/LeAgency.js'

const HISTORY_CAP = 100

const AGENCY_FIELDS =
  'ori agencyName state county agencyType employment.swornOfficers contacts surveillance.bwc enrichment'

/** The columns, lifted off an agency document. */
export function snapshotFromAgency(agency) {
  const bwc = agency.surveillance?.bwc || {}
  const contacts = agency.contacts || {}
  const enrichment = agency.enrichment || {}
  return {
    agencyName: agency.agencyName || '',
    state: agency.state || '',
    county: agency.county || '',
    agencyType: agency.agencyType || '',
    swornOfficers: agency.employment?.swornOfficers ?? null,
    cameras: {
      verdict: bwc.status || '',
      trustedVerdict: bwc.trustedResearched || '',
      trustedBy: bwc.trustedResearchedBy || '',
      reasoning: bwc.summary || '',
      sourceUrl: bwc.evidenceUrl || '',
      confidence: bwc.confidence || '',
      vendor: bwc.vendor || '',
      contractEnd: bwc.contractEnd || null,
      searchesRun: bwc.searchesRun ?? null,
      status: enrichment.bwcResearchStatus || '',
      researchedAt: enrichment.bwcResearchedAt || null,
    },
    contact: {
      chiefName: contacts.chiefName || '',
      chiefTitle: contacts.chiefTitle || '',
      chiefSourceUrl: contacts.chiefSourceUrl || '',
      chiefVerifiedAt: contacts.chiefVerifiedAt || null,
      email: contacts.email || '',
      phone: contacts.phone || '',
      website: contacts.website || '',
      commandStaff: Array.isArray(contacts.commandStaff) ? contacts.commandStaff : [],
      leadershipStatus: enrichment.leadershipStatus || '',
      checkedAt: enrichment.leadershipCheckedAt || null,
    },
  }
}

/** A history entry's copy of the columns, from the same snapshot. */
const historyFromSnapshot = (snapshot) => ({
  cameras: {
    verdict: snapshot.cameras.trustedVerdict === 'has_bwc'
      ? 'yes'
      : snapshot.cameras.trustedVerdict === 'no_bwc'
        ? 'no'
        : snapshot.cameras.verdict || 'unknown',
    reasoning: snapshot.cameras.reasoning,
    sourceUrl: snapshot.cameras.sourceUrl,
    confidence: snapshot.cameras.confidence,
    vendor: snapshot.cameras.vendor,
    contractEnd: snapshot.cameras.contractEnd
      ? new Date(snapshot.cameras.contractEnd).toISOString().slice(0, 10)
      : '',
  },
  contact: {
    chiefName: snapshot.contact.chiefName,
    chiefTitle: snapshot.contact.chiefTitle,
    email: snapshot.contact.email,
    phone: snapshot.contact.phone,
    website: snapshot.contact.website,
    sourceUrl: snapshot.contact.chiefSourceUrl,
  },
})

/**
 * Record that `ori` was just researched.
 *
 * `source` says which path did it: 'run' (the traveller's batch), 'agency'
 * (Research this agency / Research cameras), 'briefing' (the briefing panel),
 * 'manual' (a verdict set by hand). `added` and `error` come from the caller
 * when it knows them - the run loop does - and default to nothing otherwise.
 */
export async function recordAgencyResearch(
  ori,
  { source = '', runId = '', by = '', searches = 0, error = '', added = null } = {},
) {
  try {
    const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() })
      .select(AGENCY_FIELDS)
      .lean()
    if (!agency) return null

    const now = new Date()
    const snapshot = snapshotFromAgency(agency)
    const entry = {
      at: now,
      source,
      runId: runId ? String(runId) : '',
      by,
      searches: Number(searches) || 0,
      error: String(error || '').slice(0, 300),
      ...historyFromSnapshot(snapshot),
      added: {
        cameras: Boolean(added?.cameras),
        email: Boolean(added?.email),
        phone: Boolean(added?.phone),
        chief: Boolean(added?.chief),
      },
    }

    return await AgencyResearchLog.findOneAndUpdate(
      { ori: agency.ori },
      {
        $set: {
          ...snapshot,
          lastResearchedAt: now,
          lastSource: source,
          lastRunId: entry.runId,
        },
        $setOnInsert: { ori: agency.ori, firstResearchedAt: now },
        $inc: { timesResearched: 1 },
        $push: { history: { $each: [entry], $slice: -HISTORY_CAP } },
      },
      { upsert: true, new: true },
    ).lean()
  } catch (err) {
    console.error(`[research-log] could not record ${ori}: ${err?.message || err}`)
    return null
  }
}
