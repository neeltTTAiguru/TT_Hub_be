import mongoose from 'mongoose'

/**
 * A HubSpot deal plotted in its own right, whether or not it corresponds to an
 * FBI-rostered agency. Probation departments, private companies and municipal
 * contracts are real customers but appear in no federal roster, so they cannot
 * live on the LeAgency collection.
 *
 * `locationSource` records how the pin was placed, because an exact agency
 * coordinate and a county-centre approximation should never look alike.
 */
const crmDealSchema = new mongoose.Schema(
  {
    dealId: { type: String, required: true, unique: true, trim: true, index: true },
    dealName: { type: String, required: true, trim: true },
    stage: { type: String, default: '', trim: true, index: true },
    stageRank: { type: Number, default: null },
    owner: { type: String, default: '', trim: true },
    state: { type: String, default: '', trim: true, uppercase: true, index: true },

    // Set when the deal maps onto a real FBI agency.
    ori: { type: String, default: '', trim: true, uppercase: true, index: true },
    matchedAgencyName: { type: String, default: '', trim: true },
    isLawEnforcement: { type: Boolean, default: false, index: true },

    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    geo: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
    // exact | county-proxy | place-proxy | manual | none
    locationSource: { type: String, default: 'none', trim: true, index: true },
    locationNote: { type: String, default: '', trim: true },

    importedAt: { type: Date, default: null },
  },
  { timestamps: true },
)

crmDealSchema.index({ stage: 1, locationSource: 1 })
crmDealSchema.index({ geo: '2dsphere' }, { sparse: true })

const CrmDeal = mongoose.model('CrmDeal', crmDealSchema)

export default CrmDeal
