import { Router } from 'express'
import { getHubSpotHealth, refreshHubSpotHealth } from '../services/hubspotHealth.js'
import { listHubSpotTools } from '../services/hubspotMcp.js'
import { probeMemoryGateway, countBrainPages } from '../services/memoryGateway.js'

const router = Router()

router.get('/', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// Liveness of the HubSpot MCP tools in the Hermes gateway. `?probe=1` forces a
// fresh check instead of reading the background monitor's last verdict.
// status: 'ok' | 'down' | 'unknown' — see services/hubspotHealth.js.
/**
 * What the HubSpot MCP exposes, with argument schemas.
 *
 * Read-only, and here rather than in a script because the MCP credentials only
 * exist in the deployed environment - this is the only way to see the write
 * tool's real shape without guessing at it.
 */
router.get('/hubspot/tools', async (req, res, next) => {
  try {
    const tools = await listHubSpotTools()
    return res.json({
      count: tools.length,
      writeTools: tools
        .filter((tool) => /manage|create|update|delete|write|batch/i.test(tool.name))
        .map((tool) => tool.name),
      tools,
    })
  } catch (error) {
    return next(error)
  }
})

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

// Liveness of the GBrain MCP memory backend. Memory retrieval fails soft — an
// unreachable server or an expired token yields an empty context and the agent
// answers anyway — so this is the only way to tell a connected hub from one
// that is quietly answering with no memory at all.
// status: 'ok' | 'unauthorized' | 'down' | 'disabled'.
router.get('/gbrain', async (_req, res, next) => {
  try {
    const health = await probeMemoryGateway()
    // `pages` from the probe is only the 1-row liveness read; the header wants
    // the real total, which get_stats returns without enumerating pages.
    const pageCount = health.status === 'ok' ? await countBrainPages() : null
    // Mounted ahead of requireAuth, so the payload stays liveness-only: no MCP
    // URL, token, or stdio command.
    return res.status(health.status === 'ok' || health.status === 'disabled' ? 200 : 503).json({
      ...health,
      pageCount,
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    return next(error)
  }
})

export default router
