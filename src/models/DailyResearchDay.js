import mongoose from 'mongoose'

/**
 * One morning of scheduled research: who was to get how many, and how it went.
 *
 * Also the lock. The local backend and the production one share a database
 * and would both wake at five; the first to insert a document for the date
 * owns the morning and the other finds it there and stands down. The plan is
 * advanced entry by entry with atomic status flips, so two processes ticking
 * against the same document cannot both start the same run.
 */
const entrySchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    count: { type: Number, required: true },
    // pending | starting | running | settling | done | skipped | failed
    status: { type: String, default: 'pending' },
    // When 'settling' was claimed. A settle that has sat here longer than
    // SETTLE_STALE_MS was abandoned by a process that died mid-step, and is
    // re-claimable; without this one crash wedged the whole morning.
    settlingAt: { type: Date, default: null },
    // The run in flight (or the last one). `runIds` is every run this entry
    // started: the first draw plus each top-up.
    runId: { type: String, default: '' },
    runIds: { type: [String], default: [] },
    // How many were actually queued across all rounds.
    queued: { type: Number, default: 0 },
    // Leads delivered so far: researched and not found to have cameras.
    // `count` is the target for this, not for agencies researched.
    leads: { type: Number, default: 0 },
    rounds: { type: Number, default: 0 },
    note: { type: String, default: '' },
    // How the "your leads are ready" email went, or why it did not go.
    notified: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { _id: false },
)

const dailyResearchDaySchema = new mongoose.Schema(
  {
    // YYYY-MM-DD in the schedule's timezone.
    date: { type: String, required: true, unique: true },
    claimedBy: { type: String, default: '' },
    claimedAt: { type: Date, default: Date.now },
    // scheduled | manual
    trigger: { type: String, default: 'scheduled' },
    plan: { type: [entrySchema], default: [] },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

const DailyResearchDay = mongoose.model('DailyResearchDay', dailyResearchDaySchema, 'dailyresearchdays')

export default DailyResearchDay
