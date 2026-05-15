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
    attachmentLinks: {
      type: [
        {
          label: {
            type: String,
            default: '',
            trim: true,
          },
          url: {
            type: String,
            default: '',
            trim: true,
          },
          access: {
            type: String,
            default: 'public',
            trim: true,
          },
          fileType: {
            type: String,
            default: '',
            trim: true,
          },
        },
      ],
      default: [],
    },
    opportunityLinks: {
      type: [
        {
          label: {
            type: String,
            default: '',
            trim: true,
          },
          url: {
            type: String,
            default: '',
            trim: true,
          },
          updatedDate: {
            type: String,
            default: '',
            trim: true,
          },
        },
      ],
      default: [],
    },
    attachmentsLinksText: {
      type: String,
      default: '',
      trim: true,
    },
    rfpPackage: {
      type: {
        classification: { type: String, default: '', trim: true },
        originalSetAside: { type: String, default: '', trim: true },
        productServiceCode: { type: String, default: '', trim: true },
        naicsCode: { type: String, default: '', trim: true },
        placeOfPerformance: { type: String, default: '', trim: true },
        initiative: { type: String, default: '', trim: true },
        description: { type: String, default: '', trim: true },
        contactInformation: { type: String, default: '', trim: true },
        primaryPointOfContact: { type: String, default: '', trim: true },
        alternativePointOfContact: { type: String, default: '', trim: true },
        contractingOfficeAddress: { type: String, default: '', trim: true },
        attachmentsLinksText: { type: String, default: '', trim: true },
        sourceUrl: { type: String, default: '', trim: true },
        capturedAt: { type: String, default: '', trim: true },
      },
      default: {},
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
