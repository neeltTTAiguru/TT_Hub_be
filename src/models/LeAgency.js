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

/**
 * One call an SDR made to an agency.
 *
 * A log, not a record: agencies get rung more than once, and the second call
 * only makes sense next to what happened on the first. Overwriting would throw
 * away the part an SDR picking the account up later actually needs.
 *
 * Free text for what was said, a short list for what happened - the outcome is
 * the one field worth counting, so it is the one field with a shape.
 */
const callLogEntrySchema = new mongoose.Schema(
  {
    // When the call happened, which is not always when it was typed up.
    calledAt: { type: Date, default: Date.now },
    // Who actually picked up. Often not the chief, and that matters.
    contactName: { type: String, default: '', trim: true },
    contactTitle: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    outcome: { type: String, default: '', trim: true },
    // A promised call-back is the whole reason a log gets reread.
    followUpAt: { type: Date, default: null },
    notes: { type: String, default: '', trim: true },
    loggedBy: { type: String, default: '', trim: true },
    loggedAt: { type: Date, default: Date.now },
  },
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
    // A deliberately fake agency, for exercising things that write to other
    // systems. Flagged rather than named-by-convention so it can be excluded
    // from research runs and counts by query - a test record that quietly
    // joins the statistics is worse than no test record.
    isTestRecord: { type: Boolean, default: false, index: true },

    // Kyle's TMAN-P qualification, captured on the call.
    //
    // Free text, not pickers. An SDR types what the contact actually said, and
    // forcing "Q3 2026" onto "probably after the bond election, maybe spring"
    // throws away the part that mattered. Structure lives in which question it
    // answers, not in the shape of the answer.
    sdr: {
      timeline: { type: String, default: '', trim: true },
      money: { type: String, default: '', trim: true },
      authority: { type: String, default: '', trim: true },
      needs: { type: String, default: '', trim: true },
      pain: { type: String, default: '', trim: true },
      notes: { type: String, default: '', trim: true },
      // Who filled it in and when - a six-month-old answer to "when is your
      // budget cycle" is a different fact from a fresh one.
      filledBy: { type: String, default: '', trim: true },
      filledAt: { type: Date, default: null },
    },

    // Every call made to this agency, newest first.
    callLog: {
      type: [callLogEntrySchema],
      default: [],
    },
    // A summary of the log, kept alongside it deliberately.
    //
    // The map feed asks for 20,000 agencies at once and only needs to know
    // "has anyone rung them" - selecting the notes of every call to answer that
    // would put megabytes of typing on the wire for a boolean. Written on every
    // call-log change, never edited by hand.
    outreach: {
      callCount: { type: Number, default: 0 },
      lastCalledAt: { type: Date, default: null, index: true },
      lastOutcome: { type: String, default: '', trim: true },
      lastLoggedBy: { type: String, default: '', trim: true },
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
      // Written when the hub pushes an agency up to HubSpot. Holding the ids
      // is what makes a second save an update rather than a duplicate.
      hubspotCompanyId: { type: String, default: '', trim: true },
      hubspotContactId: { type: String, default: '', trim: true },
      hubspotSyncedAt: { type: Date, default: null },
      hubspotSyncError: { type: String, default: '', trim: true },

      // 'exact' links are name+state identical after normalisation; 'fuzzy' ones
      // cleared the similarity threshold and are worth spot-checking.
      matchMethod: { type: String, default: '', trim: true },
      matchConfidence: { type: Number, default: null },
      importedAt: { type: Date, default: null },
    },
    // Surveillance technology documented at this agency, from the EFF Atlas of
    // Surveillance. This is evidence that someone *recorded* a sighting, not a
    // live install base: `evidenceDate` is when a reporter or public document
    // noted the technology, often many years ago, and says nothing about
    // whether it is still in use or when it comes up for renewal.
    surveillance: {
      bwc: {
        // Derived mirror of `status === 'yes'`, kept because the map and the
        // geojson route read it. Never set it directly - set status.
        hasBwc: { type: Boolean, default: false, index: true },
        // OUR OWN verdict, and only ours: 'has_bwc' | 'no_bwc' | '' (never looked).
        //
        // Deliberately separate from `status` below, which pools four outside
        // sources of wildly different strength - a documented sighting, a
        // survey answer, a grant award, a state mandate. This field is set only
        // when Trusted Technology went and looked, so it is the one a rep can
        // be held to. Binary on purpose: it answers "do they have cameras or
        // not", which is the question that decides whether to call.
        trustedResearched: { type: String, default: '', trim: true, index: true },
        trustedResearchedAt: { type: Date, default: null },
        // 'research' when we went and looked, 'manual' when a person set it by
        // hand. Worth keeping apart: research carries a citation, a person's
        // judgement carries their name, and a later automated run must not
        // quietly overwrite something someone knew better about.
        trustedResearchedBy: { type: String, default: '', trim: true },
        trustedResearchedNote: { type: String, default: '', trim: true },
        // yes | no | planned | purchased_not_deployed | unknown.
        // The two middle states matter commercially and would be lost if
        // flattened into 'yes': an agency that has BOUGHT cameras but not
        // deployed them, or has budgeted for them, is a live opportunity
        // rather than an equipped competitor account.
        // A real 'no' can only come from a source that asked the agency;
        // the Atlas can only ever produce 'yes'.
        status: { type: String, default: 'unknown', index: true },
        // How we know, strongest first:
        //   observed  someone documented a camera (Atlas)
        //   surveyed  the agency answered a survey, either way (LEMAS)
        //   funded    took a camera grant, so is buying or has bought
        //   mandated  state law requires it - a legal duty, NOT a sighting
        evidence: { type: String, default: '', index: true },
        // When the evidence is FROM, not when we imported it. A 2016 survey
        // answer and a 2024 sighting are not comparable without this, and
        // roughly a fifth of 2016 'no' answers are already stale.
        asOf: { type: Date, default: null },
        // Why an agency said no - the LEMAS non-user block. Worth more to a
        // camera vendor than the fact of the 'no' itself.
        declineReasons: { type: [String], default: [] },
        // Normalised for filtering ('Motorola' and 'Motorola Solutions' are one
        // vendor, as are 'WatchGuard' and 'Watchguard'). Blank on roughly three
        // quarters of Atlas rows, so vendor counts are a floor, never a share.
        vendor: { type: String, default: '', trim: true, index: true },
        // Exactly as published, so a normalisation mistake stays recoverable.
        vendorRaw: { type: String, default: '', trim: true },
        // When the contract or grant period ends. The single most actionable
        // field here: a term expiring in the next year is a dated reason to
        // call, which no amount of "they have cameras" ever is.
        contractEnd: { type: Date, default: null, index: true },
        // high | medium | low. A 2018 job advert and a council contract award
        // are both 'yes'; they are not equally good.
        confidence: { type: String, default: '', trim: true },
        // What would actually settle it, when research could not. Usually a
        // records request, because purchase orders are disclosable in every
        // state and do not depend on any policy mandate.
        nextAction: { type: String, default: '', trim: true },
        // How many distinct searches were run, so a thin 'unknown' is
        // distinguishable from a thoroughly searched one.
        searchesRun: { type: Number, default: null },
        // How many, where a source states it. Useful for sizing a deal.
        cameraCount: { type: Number, default: null },
        summary: { type: String, default: '', trim: true },
        // The citation behind the sighting. Nothing here should be shown
        // without it, on the same rule the leadership fields follow.
        evidenceUrl: { type: String, default: '', trim: true },
        evidenceDate: { type: Date, default: null },
        aosNumber: { type: String, default: '', trim: true },
        source: { type: String, default: '', trim: true },
        importedAt: { type: Date, default: null },
      },
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
      // Per-agency camera research. Stamped on every ATTEMPT, not just on a
      // find, so a resumed sweep never pays twice for an agency that genuinely
      // has nothing published. ok | not-found | failed.
      // ok | not-found | failed | processing. 'processing' is claimed
      // atomically before the work starts, so two workers - or an overlapping
      // cron run - cannot research and pay for the same agency twice.
      bwcResearchStatus: { type: String, default: '', trim: true, index: true },
      bwcResearchedAt: { type: Date, default: null, index: true },
      bwcResearchStartedAt: { type: Date, default: null },
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
