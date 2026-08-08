import mongoose from 'mongoose'

const grantOpportunitySchema = new mongoose.Schema(
  {
    opportunityId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    sourceAgency: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    sourceUrl: {
      type: String,
      required: true,
      trim: true,
    },
    applicationUrl: {
      type: String,
      default: '',
      trim: true,
    },
    grantProgram: {
      type: String,
      default: '',
      trim: true,
    },
    eligibility: {
      type: String,
      default: '',
      trim: true,
    },
    deadline: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    awardRange: {
      type: String,
      default: '',
      trim: true,
    },
    matchRequired: {
      type: String,
      default: '',
      trim: true,
    },
    focusAreas: {
      type: [String],
      default: [],
    },
    fitTags: {
      type: [String],
      default: [],
    },
    fitScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      index: true,
    },
    summary: {
      type: String,
      default: '',
      trim: true,
    },
    sourceText: {
      type: String,
      default: '',
      trim: true,
    },
    sourceType: {
      type: String,
      default: 'browser-discovery',
      trim: true,
    },
    scannedAt: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  },
)

grantOpportunitySchema.index({ fitScore: -1, updatedAt: -1 })

const GrantOpportunity = mongoose.model('GrantOpportunity', grantOpportunitySchema)

export default GrantOpportunity
