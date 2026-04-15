import ChatThread from '../models/ChatThread.js'

function getUserId(req) {
  const userId = req.header('x-auth0-user-id')?.trim()

  if (!userId) {
    const error = new Error('Missing Auth0 user id.')
    error.statusCode = 401
    throw error
  }

  return userId
}

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
    const userId = getUserId(req)
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : ''
    const filter = agentId ? { userId, agentId } : { userId }
    const threads = await ChatThread.find(filter).sort({ updatedAt: -1 })
    res.json(threads)
  } catch (error) {
    next(error)
  }
}

export async function createChatThread(req, res, next) {
  try {
    const userId = getUserId(req)
    const thread = await ChatThread.create(buildThreadPayload(req.body, userId))
    res.status(201).json(thread)
  } catch (error) {
    next(error)
  }
}

export async function getChatThread(req, res, next) {
  try {
    const userId = getUserId(req)
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
    const userId = getUserId(req)
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
    const userId = getUserId(req)
    const thread = await ChatThread.findOneAndDelete({ _id: req.params.id, userId })

    if (!thread) {
      return res.status(404).json({ message: 'Chat thread not found' })
    }

    return res.status(204).send()
  } catch (error) {
    return next(error)
  }
}
