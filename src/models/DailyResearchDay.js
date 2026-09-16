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
    // pending | starting | running | done | skipped | failed
    status: { type: String, default: 'pending' },
    runId: { type: String, default: '' },
    // How many were actually queued - fewer than `count` when the pool ran dry.
    queued: { type: Number, default: 0 },
    note: { type: String, default: '' },
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
