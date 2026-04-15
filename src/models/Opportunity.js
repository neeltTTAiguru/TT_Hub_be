import mongoose from 'mongoose'

const opportunitySchema = new mongoose.Schema(
  {
    noticeId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    solicitationNumber: {
      type: String,
      default: '',
      trim: true,
    },
    agency: {
      type: String,
      default: '',
      trim: true,
    },
    office: {
      type: String,
      default: '',
      trim: true,
    },
    postedDate: {
      type: String,
      default: '',
      trim: true,
    },
    responseDeadline: {
      type: String,
      default: '',
      trim: true,
    },
    noticeType: {
      type: String,
      default: '',
      trim: true,
    },
    setAside: {
      type: String,
      default: '',
      trim: true,
    },
    naicsCode: {
      type: String,
      default: '',
      trim: true,
    },
    classificationCode: {
      type: String,
      default: '',
      trim: true,
    },
    uiLink: {
      type: String,
      default: '',
      trim: true,
    },
    descriptionLink: {
      type: String,
      default: '',
      trim: true,
    },
    sourceKeyword: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    active: {
      type: String,
      default: 'Yes',
      trim: true,
    },
  },
  {
    timestamps: true,
  },
)

opportunitySchema.index({ sourceKeyword: 1, updatedAt: -1 })

const Opportunity = mongoose.model('Opportunity', opportunitySchema)

export default Opportunity
