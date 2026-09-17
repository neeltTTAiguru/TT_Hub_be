import mongoose from 'mongoose'

/**
 * The schedule itself: on or off, and when. One document.
 *
 * Who gets how many lives on each HubMember (`dailyResearch`), so the board
 * edits it in the same row as everything else about that person.
 */
const dailyResearchScheduleSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
    enabled: { type: Boolean, default: false },
    hour: { type: Number, default: 5 },
    minute: { type: Number, default: 0 },
    timezone: { type: String, default: 'America/Los_Angeles' },
    // Which days the morning runs. 0 = Sunday ... 6 = Saturday, in the
    // schedule's timezone. Work days by default: nobody is calling agencies
    // on a Saturday, and leads researched then are stale by Monday.
    weekdays: { type: [Number], default: [1, 2, 3, 4, 5] },
    // Where the morning's random picks come from. Blank states means the
    // whole country. Always unknown camera status and never researched, on
    // top of this - that is the point of the picks, not a setting.
    pick: {
      states: { type: [String], default: [] },
      agencyTypes: { type: [String], default: [] },
      maxOfficers: { type: Number, default: 25 },
      // unknown | not_yes | any - which camera statuses are worth researching.
      camera: { type: String, default: 'unknown' },
    },
    // Whose Gmail the "your leads are ready" email goes out from. Must be a
    // member with Gmail connected; otherwise the morning runs and nobody is
    // told, which the board says.
    notifyFrom: { type: String, default: '' },
    // Copied on every leads email - a manager who wants to see what went out.
    notifyCc: { type: [String], default: [] },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true },
)

const DailyResearchSchedule = mongoose.model(
  'DailyResearchSchedule',
  dailyResearchScheduleSchema,
  'dailyresearchschedule',
)

export default DailyResearchSchedule
