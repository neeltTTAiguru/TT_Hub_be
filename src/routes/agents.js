import { Router } from 'express'
import { getAgentById, listAgents } from '../services/agentCatalog.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const agents = await listAgents()
    res.json(agents)
  } catch (error) {
    next(error)
  }
})

router.get('/:id', async (req, res, next) => {
  try {
    const agent = await getAgentById(req.params.id)

    if (!agent) {
      return res.status(404).json({ message: 'Agent not found' })
    }

    return res.json(agent)
  } catch (error) {
    return next(error)
  }
})

export default router
