import mongoose from 'mongoose'

// Approved product photography, stored as bytes rather than files.
//
// The obvious implementation writes these to assets/article-images and reads
// them back, which works locally and loses every upload in production: the app
// runs from a container whose filesystem is rebuilt on each deploy. The images
// in the repo survive because they are committed; anything uploaded at runtime
// would not. Company files already store their bytes here for the same reason.
const productImageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true, index: true },
    mimeType: { type: String, required: true, default: 'image/png' },
    sizeBytes: { type: Number, required: true },
    // Excluded by default so listing the library does not drag every photo out
    // of the database with it.
    data: { type: Buffer, required: true, select: false },
    // The one the article generator builds the device from. Exactly one row
    // carries this at a time; setReferenceImage clears the others.
    isReference: { type: Boolean, default: false },
    uploadedBy: { type: String, default: '' },
  },
  { timestamps: true },
)

const ProductImage = mongoose.model('ProductImage', productImageSchema)

export default ProductImage
