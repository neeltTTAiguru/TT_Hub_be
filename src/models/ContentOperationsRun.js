import mongoose from 'mongoose'

const contentOperationsRunSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    targetDomain: { type: String, required: true, default: 'trustedtechnology.ai', trim: true },
    requestType: { type: String, required: true, trim: true },
    userInstructions: { type: String, required: true, trim: true },
    workflowMode: {
      type: String,
      enum: ['manual', 'balanced', 'draft_automation'],
      default: 'balanced',
    },
    currentStage: { type: String, default: 'opportunity_research' },
    status: {
      type: String,
      enum: ['ready', 'running', 'waiting_for_approval', 'completed', 'error', 'stopped'],
      default: 'ready',
      index: true,
    },
    researchOnly: { type: Boolean, default: false },
    opportunities: { type: [mongoose.Schema.Types.Mixed], default: [] },
    selectedOpportunity: { type: mongoose.Schema.Types.Mixed, default: null },
    brief: { type: mongoose.Schema.Types.Mixed, default: null },
    article: { type: String, default: '' },
    generatedImages: { type: [mongoose.Schema.Types.Mixed], default: [] },
    testPublication: {
      published: { type: Boolean, default: false },
      slug: { type: String, default: '' },
      title: { type: String, default: '' },
      publishedAt: { type: Date, default: null },
      url: { type: String, default: '' },
    },
    wordpressPublication: {
      postId: { type: Number, default: null },
      status: { type: String, default: '' },
      slug: { type: String, default: '' },
      title: { type: String, default: '' },
      createdAt: { type: Date, default: null },
      url: { type: String, default: '' },
    },
    stages: { type: [mongoose.Schema.Types.Mixed], default: [] },
    toolCallsUsed: { type: [String], default: [] },
    approval: {
      opportunity: { type: Boolean, default: false },
      brief: { type: Boolean, default: false },
      article: { type: Boolean, default: false },
      publish: { type: Boolean, default: false },
    },
    errors: { type: [String], default: [] },
  },
  { timestamps: true },
)

const ContentOperationsRun = mongoose.model('ContentOperationsRun', contentOperationsRunSchema)

export default ContentOperationsRun
