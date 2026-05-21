import mongoose from 'mongoose'

const grantApplicationDraftSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    grantOpportunityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GrantOpportunity',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['draft', 'needs_review', 'ready'],
      default: 'draft',
      index: true,
    },
    draftTitle: {
      type: String,
      default: '',
      trim: true,
    },
    sections: {
      executiveSummary: { type: String, default: '' },
      needStatement: { type: String, default: '' },
      projectDescription: { type: String, default: '' },
      goalsAndOutcomes: { type: String, default: '' },
      implementationPlan: { type: String, default: '' },
      budgetNarrative: { type: String, default: '' },
      sustainabilityPlan: { type: String, default: '' },
      agencyBenefitStatement: { type: String, default: '' },
    },
    questionResponses: {
      type: [
        {
          question: { type: String, default: '' },
          answer: { type: String, default: '' },
          fieldName: { type: String, default: '' },
          fieldType: { type: String, default: '' },
          confidence: {
            type: String,
            enum: ['high', 'medium', 'low'],
            default: 'medium',
          },
          needsUserReview: { type: Boolean, default: true },
          missingInfo: { type: [String], default: [] },
        },
      ],
      default: [],
    },
    missingInformation: {
      type: [String],
      default: [],
    },
    complianceChecklist: {
      type: [String],
      default: [],
    },
    recommendedNextSteps: {
      type: [String],
      default: [],
    },
    sourceReferences: {
      type: [
        {
          label: { type: String, default: '' },
          url: { type: String, default: '' },
        },
      ],
      default: [],
    },
    portalInstructions: {
      type: String,
      default: '',
      trim: true,
    },
    rawModelOutput: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  },
)

grantApplicationDraftSchema.index({ userId: 1, grantOpportunityId: 1, updatedAt: -1 })

const GrantApplicationDraft = mongoose.model('GrantApplicationDraft', grantApplicationDraftSchema)

export default GrantApplicationDraft
