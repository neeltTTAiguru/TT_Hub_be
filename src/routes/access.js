import { Router } from 'express'
import { hasFullAccess, resolveActorEmail } from '../middleware/featureAccess.js'

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
    res.json({ email, fullAccess: hasFullAccess(email) })
  } catch (error) {
    next(error)
  }
})

export default router
