import ChatThread from '../models/ChatThread.js'
import { getAuthenticatedUser } from '../middleware/auth.js'

function sanitizeMessages(messages) {
  return Array.isArray(messages)
    ? messages.filter(
        (message) =>
          message &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string' &&
          message.content.trim(),
      )
    : []
}

function buildThreadPayload(body, userId) {
  const messages = sanitizeMessages(body?.messages)

  if (!messages.length) {
    const error = new Error('Provide at least one thread message.')
    error.statusCode = 400
    throw error
  }

  const fallbackTitle =
    messages.find((message) => message.role === 'user')?.content.slice(0, 80) || 'Saved thread'

  return {
    userId,
    agentId: typeof body?.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : 'market-researcher',
    competitor: typeof body?.competitor === 'string' ? body.competitor.trim() : '',
    title: typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : fallbackTitle,
    messages,
    thread:
      body?.thread && typeof body.thread === 'object'
        ? body.thread
        : {
            messages,
          },
  }
}

export async function listChatThreads(req, res, next) {
  try {
    const userId = getAuthenticatedUser(req).id
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : ''
    const competitor = typeof req.query.competitor === 'string' ? req.query.competitor.trim() : ''
    const filter = { userId }
    if (agentId) filter.agentId = agentId
    // Only isolate by competitor when the caller asks for a specific section, so
    // agents that don't subdivide their threads keep listing everything.
    if (competitor) filter.competitor = competitor
    // List is metadata-only (no message bodies) so the Saved-chats dropdown stays
    // cheap no matter how many chats pile up. The full thread is fetched by id
    // (getChatThread) when the user actually opens one.
    const threads = await ChatThread.find(filter)
      .select('title agentId competitor updatedAt createdAt')
      .sort({ updatedAt: -1 })
      .lean()
    res.json(threads)
  } catch (error) {
    next(error)
  }
}

export async function createChatThread(req, res, next) {
  try {
    const userId = getAuthenticatedUser(req).id
    const thread = await ChatThread.create(buildThreadPayload(req.body, userId))
    res.status(201).json(thread)
  } catch (error) {
    next(error)
  }
}

export async function getChatThread(req, res, next) {
  try {
    const userId = getAuthenticatedUser(req).id
    const thread = await ChatThread.findOne({ _id: req.params.id, userId })

    if (!thread) {
      return res.status(404).json({ message: 'Chat thread not found' })
    }

    return res.json(thread)
  } catch (error) {
    return next(error)
  }
}

export async function updateChatThread(req, res, next) {
  try {
    const userId = getAuthenticatedUser(req).id
    const update = buildThreadPayload(req.body, userId)
    const thread = await ChatThread.findOneAndUpdate({ _id: req.params.id, userId }, update, {
      new: true,
      runValidators: true,
    })

    if (!thread) {
      return res.status(404).json({ message: 'Chat thread not found' })
    }

    return res.json(thread)
  } catch (error) {
    return next(error)
  }
}

export async function deleteChatThread(req, res, next) {
  try {
    const userId = getAuthenticatedUser(req).id
    const thread = await ChatThread.findOneAndDelete({ _id: req.params.id, userId })

    if (!thread) {
      return res.status(404).json({ message: 'Chat thread not found' })
    }

    return res.status(204).send()
  } catch (error) {
    return next(error)
  }
}
