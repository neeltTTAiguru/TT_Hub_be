import { Router } from 'express'
import { handleHubMcpRequest, hubMcpKeyAccepted } from '../services/hubMcp.js'

const router = Router()

// Mounted outside requireAuth on purpose: the caller is Hermes on the droplet,
// not a person with an Auth0 session. Its credential is the HUB_MCP_KEY bearer.
router.use((req, res, next) => {
  if (!hubMcpKeyAccepted(req.headers.authorization)) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: a valid HUB_MCP_KEY bearer token is required.' },
      id: null,
    })
  }
  return next()
})

router.post('/', (req, res, next) => {
  handleHubMcpRequest(req, res).catch(next)
})

// Stateless transport: there is no session to resume or terminate.
router.get('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. POST JSON-RPC to this endpoint.' },
    id: null,
  })
})
router.delete('/', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. This server is stateless.' },
    id: null,
  })
})

export default router
