import mongoose from 'mongoose'

/**
 * A body-worn-camera research run: the queue, where the traveller has got to, and the trail he
 * has left behind.
 *
 * This lives in Mongo rather than in the browser for two reasons that are
 * really the same reason. The run has to keep going after you close the tab -
 * an overnight job that dies when a laptop sleeps is not an overnight job. And
 * everyone who opens the hub has to see the same traveller in the same place,
 * because the map is shared. Both follow from the server owning the run.
 *
 * `path` is kept in full rather than as a current position. Watching him walk
 * is the point, and a trail also answers "what did this run actually cover"
 * long after it has finished.
 */
const stopSchema = new mongoose.Schema(
  {
    ori: { type: String, default: '' },
    name: { type: String, default: '' },
    state: { type: String, default: '' },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    at: { type: Date, default: null },
    // 'yes' | 'no' | 'unknown' | 'failed' - what this stop settled, if anything.
    verdict: { type: String, default: '' },
    foundEmail: { type: Boolean, default: false },
    foundPhone: { type: Boolean, default: false },
    searches: { type: Number, default: 0 },
    error: { type: String, default: '' },

    // What the traveller actually filed, written down here rather than read
    // back off the agency later.
    //
    // The agency record holds the CURRENT truth and is overwritten by whatever
    // researches it next, so rebuilding an old run's spreadsheet from it makes
    // that spreadsheet change months after the run finished. A report has to
    // say what was found at the time.
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
    // Which of those this run actually added, as against confirming something
    // already on file. Without it a confirmed phone reads as a discovery, and
    // the run looks like it did work it did not do.
    added: {
      cameras: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
      phone: { type: Boolean, default: false },
      chief: { type: Boolean, default: false },
    },
    // Denormalised so a row can stand on its own in the sheet.
    agencyType: { type: String, default: '' },
    county: { type: String, default: '' },
    swornOfficers: { type: Number, default: null },
  },
  { _id: false },
)

const bwcResearchRunSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['running', 'stopping', 'stopped', 'done', 'failed'],
      default: 'running',
      index: true,
    },
    brief: { type: String, default: '' },
    // The targeting as it was sent, so the run can explain itself later.
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    filtersLabel: { type: String, default: '' },
    skipResearched: { type: Boolean, default: true },
    includeOffMap: { type: Boolean, default: false },

    // Resolved once at start. Re-deriving it each tick would let the queue
    // shift under the run as its own results change what matches the filter.
    queue: { type: [String], default: [] },
    cursor: { type: Number, default: 0 },

    total: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    searches: { type: Number, default: 0 },
    foundCameras: { type: Number, default: 0 },
    foundEmails: { type: Number, default: 0 },
    foundPhones: { type: Number, default: 0 },

    path: { type: [stopSchema], default: [] },
    current: { type: stopSchema, default: null },

    startedBy: { type: String, default: '' },
    // The person this run was researched for, when the daily schedule made
    // it. Their map is limited to these agencies; the board lists it under them.
    assignedTo: { type: String, default: '', index: true },
    // Started from the board for one person, outside the morning plan. The
    // plan carries the morning's "emailed" note; a mini run carries its own.
    miniRun: { type: Boolean, default: false },
    notified: { type: String, default: '' },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },

    // A lease, not a lock. If the process dies mid-agency the lease expires and
    // another boot can pick the run back up rather than leaving it wedged at
    // 'running' forever with nothing driving it.
    leaseId: { type: String, default: '' },
    leaseExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
)

bwcResearchRunSchema.index({ status: 1, createdAt: -1 })

const BwcResearchRun = mongoose.model('BwcResearchRun', bwcResearchRunSchema, 'bwcresearchruns')

export default BwcResearchRun
