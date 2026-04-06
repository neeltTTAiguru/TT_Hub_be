import mongoose from 'mongoose'

const companyContextSchema = new mongoose.Schema(
  {
    companyName: {
      type: String,
      required: true,
      default: 'Trusted Tech',
      trim: true,
    },
    companySummary: {
      type: String,
      default: '',
      trim: true,
    },
    mission: {
      type: String,
      default: '',
      trim: true,
    },
    website: {
      type: String,
      default: '',
      trim: true,
    },
    targetCustomers: {
      type: [String],
      default: [],
    },
    serviceLines: {
      type: [String],
      default: [],
    },
    activeProducts: {
      type: [String],
      default: ['Market Researcher'],
    },
    researchPriorities: {
      type: [String],
      default: [],
    },
    positioningNotes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
    collection: 'companyContexts',
  },
)

const CompanyContext = mongoose.model('CompanyContext', companyContextSchema)

export default CompanyContext
