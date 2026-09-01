import mongoose from 'mongoose'

const employmentYearSchema = new mongoose.Schema(
  {
    year: { type: Number, required: true },
    swornOfficers: { type: Number, default: null },
    maleOfficers: { type: Number, default: null },
    femaleOfficers: { type: Number, default: null },
    civilians: { type: Number, default: null },
    totalEmployees: { type: Number, default: null },
    employeesPer1000: { type: Number, default: null },
  },
  { _id: false },
)

const leAgencySchema = new mongoose.Schema(
  {
    // ORI (Originating Agency Identifier) is the only stable key across federal
    // datasets. Agency names vary by source, so never join on them.
    ori: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    agencyName: {
      type: String,
      required: true,
      trim: true,
    },
    // Every distinct spelling seen across sources, kept for audit/dedupe review.
    nameVariants: {
      type: [String],
      default: [],
    },
    agencyType: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    state: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
      index: true,
    },
    stateName: {
      type: String,
      default: '',
      trim: true,
    },
    county: {
      type: String,
      default: '',
      trim: true,
    },
    isNibrs: {
      type: Boolean,
      default: false,
    },
    nibrsStartDate: {
      type: String,
      default: '',
      trim: true,
    },
    // As published by the FBI. Never overwritten by enrichment, because the
    // feed silently substitutes the Census county internal point when it has
    // no real location - just over half our mapped agencies sit on one - and
    // losing the original would make that undetectable on a re-run.
    latitude: {
      type: Number,
      default: null,
    },
    longitude: {
      type: Number,
      default: null,
    },
    // GeoJSON mirror of latitude/longitude so Mongo can answer radius and
    // bounding-box queries directly. Only set when coordinates are present.
    geo: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number],
      },
    },
    // True when `latitude`/`longitude` are exactly the county internal point
    // from the DOJ crosswalk, i.e. the FBI had nothing better. Established by
    // comparison, not guessed, so it is safe to filter and report on.
    fbiCoordIsCountyProxy: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Resolved location, deliberately kept apart from the FBI pair above so
    // provenance survives. Readers prefer this when `precision` is set.
    location: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      geo: {
        type: {
          type: String,
          enum: ['Point'],
        },
        coordinates: {
          type: [Number],
        },
      },
      // rooftop | street | city | unresolved. Anything short of rooftop should
      // still render as an approximate pin.
      precision: { type: String, default: '', trim: true, index: true },
      geocoder: { type: String, default: '', trim: true },
      // Exactly what the geocoder echoed back, for spot-checking a bad pin.
      matchedAddress: { type: String, default: '', trim: true },
      resolvedAt: { type: Date, default: null },
    },
    employment: {
      swornOfficers: {
        type: Number,
        default: null,
        index: true,
      },
      maleOfficers: { type: Number, default: null },
      femaleOfficers: { type: Number, default: null },
      civilians: { type: Number, default: null },
      totalEmployees: { type: Number, default: null },
      employeesPer1000: { type: Number, default: null },
      dataYear: { type: Number, default: null, index: true },
      source: { type: String, default: '', trim: true },
      fetchedAt: { type: Date, default: null },
    },
    employmentHistory: {
      type: [employmentYearSchema],
      default: [],
    },
    // Populated by a later enrichment pass; the FBI feed carries no contacts.
    contacts: {
      chiefName: { type: String, default: '', trim: true },
      // Chiefs turn over constantly, so a name is only worth as much as its
      // source and its date. Both are required before any of this is shown.
      chiefTitle: { type: String, default: '', trim: true },
      chiefSourceUrl: { type: String, default: '', trim: true },
      chiefVerifiedAt: { type: Date, default: null },
      // Assistant/deputy chiefs and majors, same sourcing rule.
      commandStaff: {
        type: [
          {
            name: { type: String, default: '', trim: true },
            title: { type: String, default: '', trim: true },
            sourceUrl: { type: String, default: '', trim: true },
            verifiedAt: { type: Date, default: null },
          },
        ],
        default: [],
      },
      phone: { type: String, default: '', trim: true },
      email: { type: String, default: '', trim: true },
      website: { type: String, default: '', trim: true },
      mailingAddress: { type: String, default: '', trim: true },
      // Structured because a geocoder needs the parts, not one blob.
      streetAddress: {
        line1: { type: String, default: '', trim: true },
        line2: { type: String, default: '', trim: true },
        city: { type: String, default: '', trim: true },
        state: { type: String, default: '', trim: true, uppercase: true },
        zip: { type: String, default: '', trim: true },
        source: { type: String, default: '', trim: true },
        sourceYear: { type: Number, default: null },
      },
    },
    // Populated from a HubSpot deal export. One agency can carry several deals,
    // so `stage` reflects the furthest-along one and `deals` keeps them all.
    crm: {
      matched: { type: Boolean, default: false },
      stage: { type: String, default: '', trim: true, index: true },
      stageRank: { type: Number, default: null },
      owner: { type: String, default: '', trim: true },
      dealCount: { type: Number, default: 0 },
      deals: {
        type: [
          {
            dealId: { type: String, default: '' },
            dealName: { type: String, default: '' },
            stage: { type: String, default: '' },
            owner: { type: String, default: '' },
          },
        ],
        default: [],
      },
      // 'exact' links are name+state identical after normalisation; 'fuzzy' ones
      // cleared the similarity threshold and are worth spot-checking.
      matchMethod: { type: String, default: '', trim: true },
      matchConfidence: { type: Number, default: null },
      importedAt: { type: Date, default: null },
    },
    enrichment: {
      grantLeadIds: { type: [String], default: [] },
      knownBwcVendor: { type: String, default: '', trim: true },
      notes: { type: String, default: '', trim: true },
      // Stamped every attempt, successful or not, so a resumed run can skip
      // what it has already tried rather than paying for it twice.
      // ok | no-address | no-match | tie | failed
      locationStatus: { type: String, default: '', trim: true, index: true },
      locationAttemptedAt: { type: Date, default: null },
      // ok | not-found | unparsed | failed. Stamped on every attempt so a
      // resumed run skips what it has already looked at, and so a re-verify
      // pass can find the oldest checks first.
      leadershipStatus: { type: String, default: '', trim: true, index: true },
      leadershipCheckedAt: { type: Date, default: null, index: true },
    },
    provenance: {
      type: [
        {
          source: { type: String, default: '', trim: true },
          url: { type: String, default: '', trim: true },
          retrievedAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  },
)

// Primary prospecting query: small agencies in a state, biggest first.
leAgencySchema.index({ state: 1, 'employment.swornOfficers': 1 })
leAgencySchema.index({ agencyType: 1, 'employment.swornOfficers': 1 })
leAgencySchema.index({ 'crm.matched': 1, 'crm.stage': 1 })
leAgencySchema.index({ geo: '2dsphere' }, { sparse: true })
leAgencySchema.index({ 'location.geo': '2dsphere' }, { sparse: true })

const LeAgency = mongoose.model('LeAgency', leAgencySchema)

export default LeAgency
