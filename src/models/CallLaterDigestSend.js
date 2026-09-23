import mongoose from 'mongoose'

/**
 * One weekly call-later email, sent or attempted.
 *
 * `slot` is the lock: a scheduled send claims the local date, and the unique
 * index means the laptop and production can both tick on a Friday morning and
 * only one of them emails Kyle. A send from the board's button gets a slot of
 * its own, so it never uses up Friday's.
 */
const callLaterDigestSendSchema = new mongoose.Schema(
  {
    slot: { type: String, required: true, unique: true },
    trigger: { type: String, default: 'schedule' },
    to: { type: String, default: '' },
    count: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    note: { type: String, default: '' },
    sentBy: { type: String, default: '' },
    host: { type: String, default: '' },
    // The list as it stood when it went out. A scheduled send is also that
    // week's entry on the recipient's Your leads board, and the board must
    // show the same fifty all week rather than re-sorting under them as calls
    // are logged.
    rows: {
      type: [
        {
          _id: false,
          ori: String,
          agency: String,
          county: String,
          state: String,
          contact: String,
          contactTitle: String,
          phone: String,
          email: String,
          outcome: String,
          calledAt: Date,
          followUpAt: Date,
          loggedBy: String,
          notes: String,
          callCount: Number,
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
)

const CallLaterDigestSend = mongoose.model('CallLaterDigestSend', callLaterDigestSendSchema, 'calllaterdigestsends')

export default CallLaterDigestSend
