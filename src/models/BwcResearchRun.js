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
