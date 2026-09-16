import mongoose from 'mongoose'

/**
 * A person who signs in to the hub, and what the command board has decided
 * they get to see.
 *
 * Not the `users` collection - that is grant applicants. Nothing recorded who
 * had signed in via Auth0 until this, so the roster fills itself: /access
 * stamps every sign-in, and a full-access account can add an email ahead of
 * time. A member with no configuration sees the whole map exactly as before;
 * every restriction here is opt-in and set by a full-access account.
 *
 * `scope` is enforced on the server (the map feed, stats, call report and run
 * list all intersect it). A configured member gets no filter controls at all:
 * their map is exactly what the board gave them.
 */
const memberSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, default: '', trim: true },
    lastSeenAt: { type: Date, default: null },

    // Runs this person is working. With `limitToAssignedRuns` the map shows
    // only the agencies those runs covered - a worklist rather than a country.
    assignedRunIds: { type: [String], default: [] },
    limitToAssignedRuns: { type: Boolean, default: false },
    // How many agencies the daily schedule researches for them each morning.
    // Zero means the schedule leaves them alone.
    dailyResearch: { type: Number, default: 0 },

    // Empty list / null means no limit on that axis.
    scope: {
      states: { type: [String], default: [] },
      agencyTypes: { type: [String], default: [] },
      maxOfficers: { type: Number, default: null },
      // any | unknown | yes | no
      camera: { type: String, default: 'any' },
    },

    notes: { type: String, default: '', trim: true },
    updatedBy: { type: String, default: '', trim: true },

    // Their own Gmail, connected by them. The refresh token is stored
    // encrypted and only ever used to send as them; nothing here reads their
    // mail. Cleared on disconnect.
    gmail: {
      address: { type: String, default: '', trim: true },
      refreshToken: { type: String, default: '' },
      scopes: { type: [String], default: [] },
      connectedAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
    },
  },
  { timestamps: true },
)

const HubMember = mongoose.model('HubMember', memberSchema, 'hubmembers')

export default HubMember
