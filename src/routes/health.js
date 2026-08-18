import { Router } from 'express'
import { getHubSpotHealth, refreshHubSpotHealth } from '../services/hubspotHealth.js'

const router = Router()

router.get('/', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// Liveness of the HubSpot MCP tools in the Hermes gateway. `?probe=1` forces a
// fresh check instead of reading the background monitor's last verdict.
// status: 'ok' | 'down' | 'unknown' — see services/hubspotHealth.js.
router.get('/hubspot', async (req, res, next) => {
  try {
    const health = req.query.probe ? await refreshHubSpotHealth() : getHubSpotHealth()
    // This router is mounted ahead of requireAuth, so keep the payload to
    // liveness only — no hub id or other portal identifiers.
    const { status, checkedAt, error } = health
    return res.status(status === 'down' ? 503 : 200).json({ status, checkedAt, error })
  } catch (error) {
    return next(error)
  }
})

export default router
