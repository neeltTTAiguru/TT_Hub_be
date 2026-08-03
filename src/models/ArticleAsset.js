import mongoose from 'mongoose'

const articleAssetSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, index: true },
    role: { type: String, enum: ['hero', 'inline'], required: true, default: 'inline' },
    filename: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true, index: true },
    altText: { type: String, required: true, trim: true },
    caption: { type: String, default: '', trim: true },
    data: { type: Buffer, required: true, select: false },
  },
  { timestamps: true },
)

articleAssetSchema.index({ runId: 1, role: 1 }, { unique: true })

const ArticleAsset = mongoose.model('ArticleAsset', articleAssetSchema)

export default ArticleAsset
