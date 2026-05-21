import mongoose from 'mongoose'

const grantSourceSchema = new mongoose.Schema(
  {
    state: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    stateCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 2,
      maxlength: 2,
      index: true,
    },
    sourceName: {
      type: String,
      required: true,
      trim: true,
    },
    sourceUrl: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ['federal', 'state', 'local', 'private'],
      default: 'state',
      index: true,
    },
    focusArea: {
      type: String,
      enum: ['police', 'fire', 'ems', 'public_safety', 'general', 'other'],
      default: 'public_safety',
      index: true,
    },
    sourceType: {
      type: String,
      enum: ['grant_portal', 'agency_page', 'pdf_index', 'search_page', 'document', 'other'],
      default: 'grant_portal',
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    crawlInstructions: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastCheckedAt: {
      type: Date,
      default: null,
    },
    lastSuccessfulCheckAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  },
)

grantSourceSchema.index({ stateCode: 1, sourceUrl: 1 }, { unique: true })
grantSourceSchema.index({ stateCode: 1, category: 1, focusArea: 1, isActive: 1 })

const GrantSource = mongoose.model('GrantSource', grantSourceSchema)

export default GrantSource
