/**
 * Puts one obviously-fake agency on the map.
 *
 * It exists so writes to other systems - HubSpot, chiefly - can be exercised
 * without creating records against a real department that somebody then has to
 * find and delete. Everything about it is deliberately unmistakable: a
 * reserved-for-fiction phone number, example.com for the email and website, and
 * a name nobody could read as genuine.
 *
 * Flagged with isTestRecord, so research runs skip it and the headline counts
 * ignore it. It is on the map and nowhere else.
 *
 *   node scripts/createTestAgency.js            # create or update it
 *   node scripts/createTestAgency.js --remove   # take it off the map
 */
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import LeAgency from '../src/models/LeAgency.js'

dotenv.config()

const ORI = 'TEST00001'
// Dead centre of Texas, well away from any real pin, so it is easy to find and
// impossible to confuse with a neighbour.
const LAT = 31.4757
const LON = -99.3312

const run = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI
  if (!uri) throw new Error('MONGODB_URI is not set.')
  await mongoose.connect(uri)

  if (process.argv.includes('--remove')) {
    const result = await LeAgency.deleteOne({ ori: ORI })
    console.log(result.deletedCount ? 'Test agency removed.' : 'No test agency to remove.')
    await mongoose.disconnect()
    return
  }

  await LeAgency.updateOne(
    { ori: ORI },
    {
      $set: {
        ori: ORI,
        agencyName: 'ZZ TEST AGENCY - Trusted Tech (not real)',
        agencyType: 'City',
        state: 'TX',
        stateName: 'Texas',
        county: 'TEST COUNTY',
        isTestRecord: true,
        latitude: LAT,
        longitude: LON,
        geo: { type: 'Point', coordinates: [LON, LAT] },
        'location.latitude': LAT,
        'location.longitude': LON,
        'location.geo': { type: 'Point', coordinates: [LON, LAT] },
        'location.precision': 'street',
        'location.geocoder': 'manual',
        'location.resolvedAt': new Date(),
        'employment.swornOfficers': 7,
        // 555-01xx is reserved for fiction, and example.com cannot receive
        // mail. Nothing here can reach a real person by accident.
        'contacts.chiefName': 'Pat Testerson',
        'contacts.chiefTitle': 'Chief of Police',
        'contacts.chiefSourceUrl': 'https://example.com/test-agency/chief',
        'contacts.chiefVerifiedAt': new Date(),
        'contacts.email': 'test@example.com',
        'contacts.phone': '(555) 010-0199',
        'contacts.website': 'https://example.com',
        'contacts.streetAddress.line1': '1 Test Street',
        'contacts.streetAddress.city': 'Testville',
        'contacts.streetAddress.state': 'TX',
        'contacts.streetAddress.zip': '76888',
        'surveillance.bwc.status': 'unknown',
        'surveillance.bwc.trustedResearched': '',
      },
    },
    { upsert: true },
  )

  const agency = await LeAgency.findOne({ ori: ORI }).select('ori agencyName isTestRecord').lean()
  console.log(`Test agency ready: ${agency.agencyName} (${agency.ori})`)
  console.log(`  centre of Texas, ${LAT}, ${LON} - search "ZZ TEST" on the map`)
  console.log('  excluded from research runs and from the headline counts')
  await mongoose.disconnect()
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
