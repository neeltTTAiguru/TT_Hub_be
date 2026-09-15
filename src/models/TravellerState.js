import mongoose from 'mongoose'

/**
 * One traveller per person who has opened the map.
 *
 * `key` is who he belongs to - the caller's email, or their token subject when
 * the token carries no email - and the doc is created the first time that
 * person loads the map. The field is still called `key` rather than `userId`
 * on purpose: the collection already carries a unique index on it from when
 * there was a single traveller stored under key 'singleton', and reusing the
 * field means no index migration and no chance of a second traveller silently
 * failing to save against a stale unique index on a null field.
 *
 * Position is stored, not derived. A person's traveller is wherever they last
 * sent him - by search, by briefing, or by asking him to go - and that is an
 * instruction, so it has to be remembered or he snaps back on reload. The one
 * exception is a research run: while the run's owner has a run walking, their
 * traveller IS the walker, and `movedAt` settles the conflict afterwards - if
 * the run got somewhere more recently than they sent him, the run wins.
 *
 * `chat` is the last stretch of conversation, capped, so reloading the hub
 * does not wipe what he just told you.
 */
const chatLineSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
)

const travellerStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: '', trim: true },
    displayName: { type: String, default: '', trim: true },
    ori: { type: String, default: '', trim: true },
    name: { type: String, default: '', trim: true },
    state: { type: String, default: '', trim: true },
    county: { type: String, default: '', trim: true },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    movedAt: { type: Date, default: null },
    chat: { type: [chatLineSchema], default: [] },
    lastSeenAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
)

const TravellerState = mongoose.model('TravellerState', travellerStateSchema)

export default TravellerState
