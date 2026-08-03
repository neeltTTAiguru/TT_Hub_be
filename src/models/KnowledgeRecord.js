import mongoose from 'mongoose'

const knowledgeRecordSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    sourceDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeDocument',
      required: true,
      index: true,
    },
    sourcePages: { type: [Number], default: [] },
    category: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    products: { type: [String], default: [], index: true },
    tags: { type: [String], default: [] },
    visibility: { type: String, enum: ['public', 'internal'], default: 'internal', index: true },
    verificationStatus: {
      type: String,
      enum: ['approved', 'needs_verification', 'restricted'],
      default: 'needs_verification',
      index: true,
    },
    contentUse: {
      type: String,
      enum: ['allowed', 'use_with_citation', 'internal_only', 'do_not_use'],
      default: 'use_with_citation',
    },
    notes: { type: String, default: '' },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: '' },
  },
  { timestamps: true },
)

knowledgeRecordSchema.index({ sourceDocument: 1, key: 1 }, { unique: true })
knowledgeRecordSchema.index({ title: 'text', content: 'text', tags: 'text', products: 'text' })

const KnowledgeRecord = mongoose.model('KnowledgeRecord', knowledgeRecordSchema)

export default KnowledgeRecord
