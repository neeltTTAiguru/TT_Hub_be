import mongoose from 'mongoose'

const sourcedSchema = new mongoose.Schema(
  {
    text: { type: String, default: '' },
    url: { type: String, default: '' },
    date: { type: String, default: '' },
  },
  { _id: false },
)

/**
 * A researched briefing for one agency, cached because each run costs a web
 * search and about a minute of wall clock.
 *
 * `facts` is copied from our own data and is never model-generated. Everything
 * under `research` came from the web via the model and carries its own sources,
 * so the UI can show the two apart and never present a guess as a record.
 */
const agencyBriefingSchema = new mongoose.Schema(
  {
    ori: { type: String, required: true, unique: true, trim: true, uppercase: true, index: true },
    agencyName: { type: String, default: '', trim: true },

    facts: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    research: {
      summary: { type: String, default: '' },
      bwcStatus: {
        // yes | no | unknown - never inferred, only what a source stated.
        hasProgram: { type: String, default: 'unknown' },
        vendor: { type: String, default: '' },
        details: { type: String, default: '' },
        confidence: { type: String, default: 'low' },
      },
      budget: {
        summary: { type: String, default: '' },
        fiscalYear: { type: String, default: '' },
        signals: { type: [sourcedSchema], default: [] },
      },
      grants: { type: [sourcedSchema], default: [] },
      news: { type: [sourcedSchema], default: [] },
      outreachAngle: { type: String, default: '' },
      openQuestions: { type: [String], default: [] },
      // Topics that errored or timed out. Declared here because the service
      // sets it and Mongoose drops undeclared paths on save - without this the
      // field vanished silently, and a briefing where three of four topics
      // timed out was indistinguishable from a complete one.
      failedTopics: { type: [String], default: [] },
    },

    sources: { type: [String], default: [] },
    model: { type: String, default: '' },
    // How many web searches actually ran; zero means nothing was read.
    searchCount: { type: Number, default: 0 },
    generatedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
  },
  { timestamps: true },
)

const AgencyBriefing = mongoose.model('AgencyBriefing', agencyBriefingSchema)

export default AgencyBriefing
