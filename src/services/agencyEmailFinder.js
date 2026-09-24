/**
 * Find the email to write to at an agency, when none is on file.
 *
 * Runs the team's "Texas Law Enforcement Agency Email Finder" PromptLoop task:
 * the agency's website, its name and the chief on file go in; the best
 * published address comes back with its tier, who it belongs to, how sure the
 * finder was and the page it was on. It only returns addresses that literally
 * appear on the site - it does not guess at firstname.lastname@.
 *
 * What is found is saved on the agency, so the next click costs nothing and
 * the address also reaches HubSpot as the contact's email. A lookup that
 * found nothing is remembered for NOT_FOUND_DAYS for the same reason, unless
 * someone asks to try again.
 *
 * PROMPTLOOP_EMAIL_TASK_ID - which saved task to run (defaults to the Texas
 * finder, which in practice reads any agency's site).
 */
import LeAgency from '../models/LeAgency.js'
import { runPromptloopTask } from './promptloop.js'

const DEFAULT_TASK_ID = '1b2afaa8-0a21-4db5-b61d-4a7ddae0628f'
const NOT_FOUND_DAYS = 30

const looksLikeEmail = (value) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(value || '').trim())

const asSource = (source = {}) => ({
  source: source.source || '',
  tier: source.tier || '',
  owner: source.owner || '',
  sourceUrl: source.sourceUrl || '',
  confidence: source.confidence || '',
  notes: source.notes || '',
  foundAt: source.foundAt || null,
})

export async function findAgencyEmail(ori, { force = false } = {}) {
  const agency = await LeAgency.findOne({ ori: String(ori).toUpperCase() })
    .select('ori agencyName contacts.email contacts.emailSource contacts.website contacts.chiefName contacts.chiefTitle')
    .lean()
  if (!agency) throw Object.assign(new Error('Agency was not found.'), { statusCode: 404 })
  const contacts = agency.contacts || {}

  // Already known: nothing to pay for.
  if (contacts.email && !force) {
    return { email: contacts.email, found: true, cached: true, ...asSource(contacts.emailSource) }
  }
  const lastMiss = contacts.emailSource?.notFoundAt
  if (!force && lastMiss && Date.now() - new Date(lastMiss).getTime() < NOT_FOUND_DAYS * 86400000) {
    return {
      email: '',
      found: false,
      cached: true,
      reason: `No address was found on ${new Date(lastMiss).toLocaleDateString('en-US')}.`,
      ...asSource(contacts.emailSource),
    }
  }
  if (!contacts.website) {
    return { email: '', found: false, cached: false, reason: 'There is no website on file for this agency to search.' }
  }

  const out = await runPromptloopTask(process.env.PROMPTLOOP_EMAIL_TASK_ID?.trim() || DEFAULT_TASK_ID, [
    contacts.website,
    agency.agencyName,
    contacts.chiefName || '',
    contacts.chiefTitle || 'Chief of Police',
  ])
  const email = String(out.email || '').trim().toLowerCase()
  const source = {
    source: 'promptloop',
    tier: String(out.tier || '').slice(0, 100),
    owner: String(out.email_owner || '').slice(0, 200),
    sourceUrl: String(out.source_url || '').slice(0, 500),
    confidence: String(out.confidence || '').slice(0, 50),
    notes: String(out.notes || '').slice(0, 1000),
  }

  if (!looksLikeEmail(email)) {
    await LeAgency.updateOne(
      { ori: agency.ori },
      { $set: { 'contacts.emailSource': { ...source, foundAt: null, notFoundAt: new Date() } } },
    )
    return { email: '', found: false, cached: false, reason: source.notes || 'No published address was found.', ...source }
  }

  // Never over a hand-entered address, even on a forced re-run.
  await LeAgency.updateOne(
    { ori: agency.ori, $or: [{ 'contacts.email': '' }, { 'contacts.email': { $exists: false } }, { 'contacts.emailSource.source': 'promptloop' }] },
    { $set: { 'contacts.email': email, 'contacts.emailSource': { ...source, foundAt: new Date(), notFoundAt: null } } },
  )
  return { email, found: true, cached: false, ...source, foundAt: new Date() }
}
