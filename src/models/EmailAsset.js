import mongoose from 'mongoose'

// Images embedded in a campaign have to be reachable from the recipient's mail
// client, so they are stored here and served from a public route. Gmail refuses
// to render data: URIs, which is why inlining them is not an option.
const emailAssetSchema = new mongoose.Schema(
  {
    sha256: { type: String, required: true, unique: true, index: true },
    mimeType: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, required: true },
    data: { type: Buffer, required: true, select: false },
  },
  { timestamps: true },
)

const EmailAsset = mongoose.model('EmailAsset', emailAssetSchema)

export default EmailAsset
