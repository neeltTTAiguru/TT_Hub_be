import mongoose from 'mongoose'

/**
 * Where the traveller is standing, when he was put there by hand.
 *
 * A single document. Normally his position is derived - the agency being
 * researched, or the last one finished - and needs no storage at all. This
 * exists only for the case where someone tells him to go somewhere: that is an
 * instruction, not an observation, so it has to be remembered or he snaps back
 * to the last research the moment the page reloads.
 *
 * `movedAt` is what settles a conflict: if research has happened since he was
 * sent somewhere, the research wins, because he has evidently moved on.
 */
const travellerStateSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true, index: true },
    ori: { type: String, default: '', trim: true },
    name: { type: String, default: '', trim: true },
    state: { type: String, default: '', trim: true },
    county: { type: String, default: '', trim: true },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    movedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

const TravellerState = mongoose.model('TravellerState', travellerStateSchema)

export default TravellerState
