import { Router } from 'express'
import { getAgentById, listAgents } from '../services/agentCatalog.js'
import { chatWithHermes, streamHermesChat } from '../services/hermesChat.js'
import { chatWithAgent } from '../services/openaiChat.js'
import { handleWordPressChat } from '../services/wordpressDraftEditor.js'
import { getAuthenticatedUser } from '../middleware/auth.js'
import { retrieveMemoryContext, saveApprovedMemory, listSectionMemories, listBrainSectionMemories } from '../services/memoryGateway.js'
import { researchCompetitorWebsite } from '../services/competitorResearch.js'
import { refreshAllCompetitorSections, getCollectorStatus } from '../services/competitorCollector.js'
import { chatWithHubSpotDeals, HUBSPOT_DEAL_INSTRUCTIONS } from '../services/hubspotDeals.js'
import { chatWithYouTrack } from '../services/youtrack.js'
import { getWordPressPost, getWordPressEditorUrl, getWordPressSiteUrl } from '../services/wordpress.js'

const router = Router()

let wordpressStylesheetCache = { siteUrl: '', expiresAt: 0, stylesheets: [], inlineStyles: [] }

// Prefer Hermes (same backend as Brain), but bound how long we wait on it: if
// Hermes is slow or offline, fall back to the fast OpenAI-backed chat instead of
// hanging until the gateway times out (~2 min). Used by Competitor Analyst.
const COMPETITOR_HERMES_TIMEOUT_MS = Number(process.env.COMPETITOR_HERMES_TIMEOUT_MS || 25000)

async function chatWithHermesOrOpenAI(agentId, messages, options) {
  try {
    return await chatWithHermes(agentId, messages, {
      ...options,
      timeoutMs: COMPETITOR_HERMES_TIMEOUT_MS,
      rateLimitRetries: 0,
    })
  } catch (error) {
    const message = String(error?.message || '')
    const hermesOffline =
      error?.statusCode === 503 ||
      error?.statusCode === 504 ||
      /fetch failed|ECONNREFUSED|not configured|took too long|empty response|aborted/i.test(message)
    if (!hermesOffline) throw error
    // Hermes was slow/unavailable — answer with the fast OpenAI path instead.
    return chatWithAgent(agentId, messages, options)
  }
}

function rendered(field) {
  return typeof field === 'string' ? field : String(field?.rendered ?? field?.raw ?? '')
}

async function getWordPressStylesheets() {
  const siteUrl = getWordPressSiteUrl()
  if (!siteUrl) return { stylesheets: [], inlineStyles: [] }
  if (wordpressStylesheetCache.siteUrl === siteUrl && wordpressStylesheetCache.expiresAt > Date.now()) {
    return wordpressStylesheetCache
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(siteUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'TrustedTechHub/1.0' },
    })
    if (!response.ok) return []
    const html = (await response.text()).slice(0, 750000)
    const stylesheets = [...html.matchAll(/<link\b[^>]*\brel=(['"])[^'"]*stylesheet[^'"]*\1[^>]*>/gi)]
      .map(([tag]) => tag.match(/\bhref=(['"])(.*?)\1/i)?.[2] || '')
      .filter(Boolean)
      .map((href) => href.replace(/&amp;|&#0*38;/gi, '&'))
      .map((href) => new URL(href, siteUrl).href)
      .filter((href) => /^https?:\/\//i.test(href))
      .slice(0, 40)
    const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
      .map((match) => match[1].trim())
      .filter(Boolean)
      .slice(0, 30)
    wordpressStylesheetCache = { siteUrl, expiresAt: Date.now() + 5 * 60 * 1000, stylesheets, inlineStyles }
    return wordpressStylesheetCache
  } catch {
    return { stylesheets: [], inlineStyles: [] }
  } finally {
    clearTimeout(timeout)
  }
}

router.get('/wordpress-draft-editor/preview/:postId', async (req, res, next) => {
  try {
    const draft = await getWordPressPost(req.params.postId)
    const { stylesheets, inlineStyles } = await getWordPressStylesheets()
    return res.json({
      id: draft.id,
      type: draft.type,
      title: rendered(draft.title),
      content: rendered(draft.content),
      excerpt: rendered(draft.excerpt),
      reviewUrl: getWordPressEditorUrl(draft.id),
      siteUrl: getWordPressSiteUrl(),
      stylesheets,
      inlineStyles,
      modified: draft.modified || '',
    })
  } catch (error) {
    return next(error)
  }
})

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
      : req.params.id === 'competitor-analyst'
      ? await chatWithHermesOrOpenAI(req.params.id, sanitizedMessages, memoryOptions)
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

// Streaming chat over Server-Sent Events. Emits `data: {"delta":"..."}` per token
// and a final `data: {"done":true,"message":...}`. Heartbeat comments keep the
// connection warm during the (silent) tool-call phase so long HubSpot analyses
// don't hit a fixed request cap or a proxy idle-timeout.
const STREAMING_AGENTS = new Set([
  'trusted-tech-hubspot-assistant',
  'trusted-tech-assistant',
  'competitor-analyst',
  'content-operations-assistant',
  'trusted-tech-ahrefs-assistant',
])

router.post('/:id/chat/stream', async (req, res, next) => {
  const agentId = req.params.id
  try {
    if (!STREAMING_AGENTS.has(agentId)) {
      return res.status(501).json({ message: 'Streaming is not available for this agent.' })
    }
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
    const memory = await retrieveMemoryContext({ agentId, messages: sanitizedMessages, user })

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    res.write(': open\n\n')

    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n') } catch { /* client gone */ }
    }, 15000)

    const clientAbort = new AbortController()
    req.on('close', () => clientAbort.abort())

    try {
      const { content } = await streamHermesChat(
        agentId,
        sanitizedMessages,
        {
          memoryContext: memory.context,
          timeoutMs: Number(process.env.HERMES_STREAM_TIMEOUT_MS || 240000),
          instructions: agentId === 'trusted-tech-hubspot-assistant' ? HUBSPOT_DEAL_INSTRUCTIONS : undefined,
          signal: clientAbort.signal,
        },
        (delta) => {
          res.write(`data: ${JSON.stringify({ delta })}\n\n`)
        },
      )
      res.write(`data: ${JSON.stringify({
        done: true,
        message: { role: 'assistant', content },
        meta: { provider: 'hermes', memory: { status: memory.status, retrieved: memory.memories.length } },
      })}\n\n`)
    } catch (error) {
      if (error?.code !== 'RUN_STOPPED') {
        res.write(`data: ${JSON.stringify({ error: error?.message || 'Hermes stream failed.' })}\n\n`)
      }
    } finally {
      clearInterval(heartbeat)
      res.end()
    }
  } catch (error) {
    if (!res.headersSent) return next(error)
    try { res.end() } catch { /* already closed */ }
  }
})

// Triggers the background collector that reads EVERY competitor's website and
// writes their models into each brain section. Fire-and-forget; returns 202.
router.post('/:id/collect', async (req, res, next) => {
  try {
    if (req.params.id !== 'competitor-analyst') {
      return res.status(404).json({ message: 'Collection is only available for Competitor Analyst.' })
    }
    getAuthenticatedUser(req)
    const status = getCollectorStatus()
    if (status.running) {
      return res.status(202).json({ started: false, alreadyRunning: true })
    }
    // Fire-and-forget: the sweep takes minutes; don't hold the request open.
    refreshAllCompetitorSections().catch((error) => console.error('manual competitor collect failed', error))
    return res.status(202).json({ started: true })
  } catch (error) {
    return next(error)
  }
})

// Reports the last collector run + whether one is in progress.
router.get('/:id/collect/status', async (req, res, next) => {
  try {
    if (req.params.id !== 'competitor-analyst') {
      return res.status(404).json({ message: 'Collection is only available for Competitor Analyst.' })
    }
    getAuthenticatedUser(req)
    return res.json(getCollectorStatus())
  } catch (error) {
    return next(error)
  }
})

// Reads a competitor's own website (homepage + product pages) and extracts their
// BWC models/specs so the section acts as a mini research hub for that competitor.
router.post('/:id/sections/:competitor/research', async (req, res, next) => {
  try {
    if (req.params.id !== 'competitor-analyst') {
      return res.status(404).json({ message: 'Sections are only available for Competitor Analyst.' })
    }
    getAuthenticatedUser(req)
    const result = await researchCompetitorWebsite(req.params.competitor)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

// Loads a competitor's brain-section memory from GBrain so the UI can prime the
// chat when that competitor is selected.
router.get('/:id/sections/:competitor/memories', async (req, res, next) => {
  try {
    if (req.params.id !== 'competitor-analyst') {
      return res.status(404).json({ message: 'Sections are only available for Competitor Analyst.' })
    }
    const user = getAuthenticatedUser(req)
    const result = await listSectionMemories({
      agentId: req.params.id,
      competitor: req.params.competitor,
      user,
    })
    return res.json({ competitor: req.params.competitor, ...result })
  } catch (error) {
    return next(error)
  }
})

// Loads one Brain "section" — the company-wide pool ('company') or a single
// agent's scoped memories — so the Brain UI can show what a section knows and
// talk to it directly (mirrors the competitor sections endpoint above).
router.get('/:id/brain-sections/:section/memories', async (req, res, next) => {
  try {
    const user = getAuthenticatedUser(req)
    const section = req.params.section
    if (section !== 'company' && section !== 'shared') {
      const agents = await listAgents()
      const validAgentIds = new Set(agents.map((agent) => agent.id))
      if (!validAgentIds.has(section)) {
        return res.status(400).json({ message: 'Choose a valid brain section.' })
      }
    }
    const result = await listBrainSectionMemories({ agentId: req.params.id, section, user })
    return res.json({ section, ...result })
  } catch (error) {
    return next(error)
  }
})

router.post('/:id/memory', async (req, res, next) => {
  try {
    const user = getAuthenticatedUser(req)
    const incoming = req.body?.proposal || {}
    // The client picks a brain "section": either the whole company (all agents)
    // or one specific agent. Company-wide memory carries no allowed_agents
    // restriction; an agent section scopes retrieval to exactly that agent.
    const section = typeof incoming.section === 'string' ? incoming.section.trim() : 'company'
    let allowedAgents = []
    if (section && section !== 'company' && section !== 'shared') {
      const agents = await listAgents()
      const validAgentIds = new Set(agents.map((agent) => agent.id))
      if (!validAgentIds.has(section)) {
        return res.status(400).json({ message: 'Choose a valid brain section.' })
      }
      allowedAgents = [section]
    }
    const memory = await saveApprovedMemory({
      agentId: req.params.id,
      user,
      // `competitor` (a tracked-competitor slug) turns the save into a
      // per-competitor brain section; `model` scopes it to a specific BWC model
      // line item. saveApprovedMemory validates the competitor.
      proposal: { ...incoming, department: 'shared', allowedAgents, competitor: incoming.competitor, model: incoming.model },
      confirmed: req.body?.confirmed,
    })
    return res.status(201).json({ ...memory, section })
  } catch (error) {
    return next(error)
  }
})

export default router
