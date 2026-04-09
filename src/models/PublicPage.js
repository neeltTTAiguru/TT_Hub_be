import mongoose from 'mongoose'

const publicPageSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    pageType: {
      type: String,
      default: 'general',
      trim: true,
    },
    summary: {
      type: String,
      default: '',
      trim: true,
    },
    highlights: {
      type: [String],
      default: [],
    },
    rawText: {
      type: String,
      default: '',
      trim: true,
    },
    sourceDomain: {
      type: String,
      default: '',
      trim: true,
    },
    visibility: {
      type: String,
      enum: ['public', 'internal'],
      default: 'public',
    },
    lastReviewedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
)

const PublicPage = mongoose.model('PublicPage', publicPageSchema)

export default PublicPage
