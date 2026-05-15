import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    createdBy: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    isAdmin: {
      type: Boolean,
      default: false,
      index: true,
    },
    role: {
      type: String,
      default: 'Member',
      trim: true,
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    userType: {
      type: String,
      enum: ['trusted_employee', 'police_officer', 'firefighter', 'agency_admin', 'non_trusted_employee'],
      default: 'trusted_employee',
    },
    onboardingFlow: {
      type: String,
      enum: ['trusted_employee', 'public_safety', 'external_reviewer', 'restricted_guest'],
      default: 'trusted_employee',
    },
    agencyName: {
      type: String,
      default: '',
      trim: true,
    },
    agencyType: {
      type: String,
      default: '',
      trim: true,
    },
    city: {
      type: String,
      default: '',
      trim: true,
    },
    state: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
    },
    department: {
      type: String,
      default: '',
      trim: true,
    },
    accessScope: {
      type: String,
      enum: ['internal', 'agency_workspace', 'grant_drafting_only', 'read_only'],
      default: 'internal',
    },
    grantProjectFocus: {
      type: String,
      default: '',
      trim: true,
    },
    targetGrantTypes: {
      type: [String],
      default: [],
    },
    promptVariables: {
      agencyName: { type: String, default: '' },
      agencyType: { type: String, default: '' },
      location: { type: String, default: '' },
      roleContext: { type: String, default: '' },
      projectFocus: { type: String, default: '' },
      knownNeeds: { type: String, default: '' },
      grantRequirements: { type: String, default: '' },
    },
    status: {
      type: String,
      enum: ['active', 'invited', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  },
)

const User = mongoose.model('User', userSchema)

export default User
