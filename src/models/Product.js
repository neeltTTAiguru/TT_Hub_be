import mongoose from 'mongoose'

const productSpecSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
    },
    value: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false },
)

const productSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      default: 'general',
      trim: true,
    },
    summary: {
      type: String,
      default: '',
      trim: true,
    },
    targetMarkets: {
      type: [String],
      default: [],
    },
    features: {
      type: [String],
      default: [],
    },
    claims: {
      type: [String],
      default: [],
    },
    specs: {
      type: [productSpecSchema],
      default: [],
    },
    sourceUrls: {
      type: [String],
      default: [],
    },
    visibility: {
      type: String,
      enum: ['public', 'internal'],
      default: 'public',
    },
  },
  {
    timestamps: true,
  },
)

const Product = mongoose.model('Product', productSchema)

export default Product
