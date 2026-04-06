import mongoose from 'mongoose'

const competitorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    website: {
      type: String,
      default: '',
      trim: true,
    },
    category: {
      type: String,
      default: 'general',
      trim: true,
    },
    status: {
      type: String,
      enum: ['watching', 'priority', 'inactive'],
      default: 'watching',
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    strengths: {
      type: [String],
      default: [],
    },
    watchSignals: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  },
)

const Competitor = mongoose.model('Competitor', competitorSchema)

export default Competitor
