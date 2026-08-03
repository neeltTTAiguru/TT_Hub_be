import mongoose from 'mongoose'

const knowledgeDocumentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    originalFilename: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, default: 'application/pdf' },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true, unique: true, index: true },
    sourceType: { type: String, default: 'internal_handbook' },
    visibility: { type: String, enum: ['public', 'internal'], default: 'internal' },
    approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    products: { type: [String], default: [] },
    extractedText: { type: String, required: true },
    fileData: { type: Buffer, required: true, select: false },
    pageCount: { type: Number, default: 0 },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: '' },
  },
  { timestamps: true },
)

const KnowledgeDocument = mongoose.model('KnowledgeDocument', knowledgeDocumentSchema)

export default KnowledgeDocument
