import { Router } from 'express'
import { getAgentById, listAgents } from '../services/agentCatalog.js'
import { chatWithHermes } from '../services/hermesChat.js'
import { chatWithAgent } from '../services/openaiChat.js'

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

router.post('/:id/chat', async (req, res, next) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : []
    const sanitizedMessages = messages
      .filter(
        (message) =>
          message &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string' &&
          message.content.trim(),
      )
      .slice(-12)

    if (!sanitizedMessages.length) {
      return res.status(400).json({ message: 'Provide at least one chat message.' })
    }

    const result =
      req.params.id === 'trusted-tech-assistant' ||
      req.params.id === 'trusted-tech-hubspot-assistant'
        ? await chatWithHermes(req.params.id, sanitizedMessages)
        : await chatWithAgent(req.params.id, sanitizedMessages)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

export default router
