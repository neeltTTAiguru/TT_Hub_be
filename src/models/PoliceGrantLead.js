import mongoose from 'mongoose'

const policeGrantLeadSchema = new mongoose.Schema(
  {
    leadId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    agencyName: {
      type: String,
      required: true,
      trim: true,
    },
    locationName: {
      type: String,
      default: '',
      trim: true,
    },
    state: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    estimatedAgencySize: {
      type: String,
      default: 'Unknown',
      trim: true,
    },
    grantAmount: {
      type: Number,
      default: 0,
    },
    grantAmountText: {
      type: String,
      default: '',
      trim: true,
    },
    fundingProgram: {
      type: String,
      default: '',
      trim: true,
    },
    fundingSource: {
      type: String,
      default: '',
      trim: true,
    },
    grantDate: {
      type: String,
      default: '',
      trim: true,
    },
    grantEndDate: {
      type: String,
      default: '',
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    opportunityScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
      index: true,
    },
    likelyNeeds: {
      type: [String],
      default: [],
    },
    whyThisMatters: {
      type: String,
      default: '',
      trim: true,
    },
    startupOpportunity: {
      type: String,
      default: '',
      trim: true,
    },
    recommendedAction: {
      type: String,
      enum: ['Immediate outreach', 'High priority', 'Monitor', 'Low priority'],
      default: 'Monitor',
      index: true,
    },
    sourceUrl: {
      type: String,
      required: true,
      trim: true,
    },
    sourceType: {
      type: String,
      default: 'policefundingdatabase.org',
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

policeGrantLeadSchema.index({ opportunityScore: -1, updatedAt: -1 })

const PoliceGrantLead = mongoose.model('PoliceGrantLead', policeGrantLeadSchema)

export default PoliceGrantLead
