import mongoose from 'mongoose'

/**
 * Every agency that has ever been researched, one document each, with the
 * columns as they stand now and a trail of how they got there.
 *
 * Why a separate collection when the agency record already carries the
 * answer: the agency is the CURRENT truth, overwritten by whatever researches
 * it next. A run's `path` keeps what a run filed, but "Research this agency"
 * and the traveller chat never pass through a run, so a third of the work left
 * no record beyond the overwritten fields. This is the one place that answers
 * "which agencies have we researched, what did we find, and when" without
 * joining three collections and guessing.
 *
 * Written by every research path (the run loop, the per-agency stream, the
 * briefing, a hand-set verdict) and rebuilt wholesale by
 * scripts/backfillAgencyResearchLog.js. `history` is capped so a much-visited
 * agency cannot grow without bound; the newest entries are the ones kept.
 */
const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    // run | agency | briefing | manual | backfill
    source: { type: String, default: '' },
    runId: { type: String, default: '' },
    by: { type: String, default: '' },
    searches: { type: Number, default: 0 },
    error: { type: String, default: '' },
    cameras: {
      verdict: { type: String, default: '' },
      reasoning: { type: String, default: '' },
      sourceUrl: { type: String, default: '' },
      confidence: { type: String, default: '' },
      vendor: { type: String, default: '' },
      contractEnd: { type: String, default: '' },
    },
    contact: {
      chiefName: { type: String, default: '' },
      chiefTitle: { type: String, default: '' },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
      website: { type: String, default: '' },
      sourceUrl: { type: String, default: '' },
    },
    added: {
      cameras: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
      phone: { type: Boolean, default: false },
      chief: { type: Boolean, default: false },
    },
  },
  { _id: false },
)

const agencyResearchLogSchema = new mongoose.Schema(
  {
    ori: { type: String, required: true, unique: true, index: true },
    agencyName: { type: String, default: '', index: true },
    state: { type: String, default: '', index: true },
    county: { type: String, default: '' },
    agencyType: { type: String, default: '', index: true },
    swornOfficers: { type: Number, default: null },

    // The columns, as the agency record holds them right now.
    cameras: {
      // yes | no | unknown | planned | purchased_not_deployed
      verdict: { type: String, default: '', index: true },
      // has_bwc | no_bwc | '' - our own binary call, hand-set or researched.
      trustedVerdict: { type: String, default: '' },
      // research | manual | ''
      trustedBy: { type: String, default: '' },
      reasoning: { type: String, default: '' },
      sourceUrl: { type: String, default: '' },
      confidence: { type: String, default: '' },
      vendor: { type: String, default: '' },
      contractEnd: { type: Date, default: null },
      searchesRun: { type: Number, default: null },
      // ok | not-found | failed
      status: { type: String, default: '' },
      researchedAt: { type: Date, default: null },
    },
    contact: {
      chiefName: { type: String, default: '' },
      chiefTitle: { type: String, default: '' },
      chiefSourceUrl: { type: String, default: '' },
      chiefVerifiedAt: { type: Date, default: null },
      email: { type: String, default: '' },
      phone: { type: String, default: '' },
      website: { type: String, default: '' },
      commandStaff: { type: [mongoose.Schema.Types.Mixed], default: [] },
      leadershipStatus: { type: String, default: '' },
      checkedAt: { type: Date, default: null },
    },

    firstResearchedAt: { type: Date, default: null },
    lastResearchedAt: { type: Date, default: null, index: true },
    timesResearched: { type: Number, default: 0 },
    lastSource: { type: String, default: '' },
    lastRunId: { type: String, default: '' },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
)

const AgencyResearchLog = mongoose.model(
  'AgencyResearchLog',
  agencyResearchLogSchema,
  'agencyresearchlog',
)

export default AgencyResearchLog
