import { Router } from 'express'
import { getAgentById, listAgents } from '../services/agentCatalog.js'
import { chatWithHermes } from '../services/hermesChat.js'
import { chatWithAgent } from '../services/openaiChat.js'
import { handleWordPressChat } from '../services/wordpressDraftEditor.js'
import { getAuthenticatedUser } from '../middleware/auth.js'
import { retrieveMemoryContext, saveApprovedMemory } from '../services/memoryGateway.js'
import { chatWithHubSpotDeals } from '../services/hubspotDeals.js'
import { chatWithYouTrack } from '../services/youtrack.js'

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

    const user = getAuthenticatedUser(req)
    const memory = await retrieveMemoryContext({
      agentId: req.params.id,
      messages: sanitizedMessages,
      user,
    })
    const memoryOptions = {
      memoryContext: memory.context,
      memoryMeta: {
        status: memory.status,
        retrieved: memory.memories.length,
      },
    }

    const result = req.params.id === 'trusted-tech-hubspot-assistant'
      ? await chatWithHubSpotDeals(sanitizedMessages, memoryOptions)
      : req.params.id === 'trusted-tech-youtrack-assistant'
      ? await chatWithYouTrack(sanitizedMessages, memoryOptions)
      : req.params.id === 'wordpress-draft-editor'
      ? await handleWordPressChat(sanitizedMessages, memoryOptions)
      : req.params.id === 'trusted-tech-assistant' ||
      req.params.id === 'trusted-tech-hubspot-assistant' ||
      req.params.id === 'trusted-tech-youtrack-assistant' ||
      req.params.id === 'trusted-tech-ahrefs-assistant' ||
      req.params.id === 'content-operations-assistant' ||
      req.params.id === 'wordpress-draft-test-agent'
        ? await chatWithHermes(
          req.params.id,
          sanitizedMessages,
          req.params.id === 'trusted-tech-hubspot-assistant'
            ? { ...memoryOptions, timeoutMs: 30000, rateLimitRetries: 1 }
            : memoryOptions,
        )
        : await chatWithAgent(req.params.id, sanitizedMessages, memoryOptions)
    result.meta = { ...(result.meta || {}), memory: memoryOptions.memoryMeta }
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

router.post('/:id/memory', async (req, res, next) => {
  try {
    const user = getAuthenticatedUser(req)
    const memory = await saveApprovedMemory({
      agentId: req.params.id,
      user,
      proposal: req.body?.proposal,
      confirmed: req.body?.confirmed,
    })
    return res.status(201).json(memory)
  } catch (error) {
    return next(error)
  }
})

export default router
