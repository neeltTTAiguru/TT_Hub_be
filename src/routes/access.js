import { Router } from 'express'
import { hasFullAccess, resolveActorEmail } from '../middleware/featureAccess.js'
import HubMember from '../models/HubMember.js'
import { memberViewFor, touchMember } from '../services/hubMembers.js'

const router = Router()

/**
 * What this account is allowed to see.
 *
 * The sidebar needs the answer before it renders, and the alternative - ship
 * the allowlist to the browser and let it decide - puts the list of who matters
 * in a static bundle on a CDN and duplicates the rule in two places that will
 * drift. The server owns the rule; the client asks.
 *
 * Mounted above requireFeatureAccess, or a restricted account could never learn
 * that it is restricted.
 */
router.get('/', async (req, res, next) => {
  try {
    const email = await resolveActorEmail(req)
    const fullAccess = hasFullAccess(email)
    // Every sign-in lands on the command board's roster, so the people to
    // configure are the people who actually turn up rather than a typed list.
    await touchMember(email)
    // A restricted account also learns its rules here, in the same round trip
    // the sidebar already waits for. Full-access accounts have none.
    const member = fullAccess ? null : await memberViewFor(await HubMember.findOne({ email }).lean())
    res.json({ email, fullAccess, member })
  } catch (error) {
    next(error)
  }
})

export default router
