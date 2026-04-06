import mongoose from 'mongoose'

const sourceSchema = new mongoose.Schema(
  {
    label: { type: String, default: '', trim: true },
    url: { type: String, default: '', trim: true },
    sourceType: { type: String, default: 'web', trim: true },
  },
  { _id: false },
)

const findingSchema = new mongoose.Schema(
  {
    summary: {
      type: String,
      required: true,
      trim: true,
    },
    implication: {
      type: String,
      default: '',
      trim: true,
    },
    confidence: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    sources: {
      type: [sourceSchema],
      default: [],
    },
  },
  { _id: false },
)

const researchRunSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    objective: {
      type: String,
      required: true,
      trim: true,
    },
    scope: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['queued', 'in_progress', 'completed'],
      default: 'queued',
    },
    requestedBy: {
      type: String,
      default: 'trusted-tech',
      trim: true,
    },
    findings: {
      type: [findingSchema],
      default: [],
    },
    recommendedNextSteps: {
      type: [String],
      default: [],
    },
    reportSummary: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  },
)

const ResearchRun = mongoose.model('ResearchRun', researchRunSchema)

export default ResearchRun
