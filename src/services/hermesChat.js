import { getAgentChatInstructions } from './openaiChat.js'
import { retrieveMemoryContext } from './memoryGateway.js'

const DEFAULT_HERMES_MODEL = process.env.HERMES_MODEL || 'hermes-agent'
const REQUEST_TIMEOUT_MS = Number(process.env.HERMES_REQUEST_TIMEOUT_MS || 120000)
const RATE_LIMIT_RETRIES = Number(process.env.HERMES_RATE_LIMIT_RETRIES || 6)
const MAX_RETRY_DELAY_MS = Number(process.env.HERMES_MAX_RETRY_DELAY_MS || 15000)

function getHermesConfig() {
  const baseUrl = String(process.env.HERMES_API_URL || '').replace(/\/$/, '')
  const apiKey = String(process.env.HERMES_API_KEY || '')

  if (!baseUrl || !apiKey) {
    const error = new Error('Hermes is not configured on the backend.')
    error.statusCode = 503
    throw error
  }

  return { baseUrl, apiKey }
}

function getHermesContent(payload) {
  const content = payload?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

export function isHermesRateLimit(status, body = '') {
  return status === 429 || /rate\s*limit|tokens per min|\bTPM\b|try again in/i.test(String(body))
}

export function getHermesRetryDelayMs(body = '', attempt = 0) {
  const match = String(body).match(/try again in\s+([\d.]+)\s*(ms|s|sec|seconds?)/i)
  const parsed = match ? Number(match[1]) * (match[2].toLowerCase() === 'ms' ? 1 : 1000) : 0
  const fallback = Math.min(2000 * (attempt + 1), MAX_RETRY_DELAY_MS)
  return Math.min(Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed + 500 : fallback, 500), MAX_RETRY_DELAY_MS)
}

function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    const abort = () => {
      clearTimeout(timer)
      const error = new Error('Request aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
}

// Streaming variant: sends stream:true to Hermes, parses the OpenAI-style SSE,
// and invokes onDelta(text) for each content chunk. Returns the full text once
// the stream ends. Keeping the connection flowing is what lets long, tool-heavy
// HubSpot analyses run past a fixed request cap without the proxy killing them.
export async function streamHermesChat(agentId, messages, options = {}, onDelta = () => {}) {
  const { baseUrl, apiKey } = getHermesConfig()
  const baseInstructions = typeof options.instructions === 'string'
    ? options.instructions
    : (await getAgentChatInstructions(agentId)).instructions
  const memoryContext = typeof options.memoryContext === 'string' ? options.memoryContext.trim() : ''
  const instructions = memoryContext ? `${baseInstructions}\n\n${memoryContext}` : baseInstructions

  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs || REQUEST_TIMEOUT_MS)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromCaller = () => controller.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: DEFAULT_HERMES_MODEL,
        messages: [
          { role: 'system', content: instructions },
          ...messages.map(({ role, content }) => ({ role, content })),
        ],
        stream: true,
      }),
      signal: controller.signal,
    })

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '')
      const error = new Error(
        isHermesRateLimit(response.status, body)
          ? 'The HubSpot query is still processing. Please retry shortly.'
          : (body || `Hermes request failed with ${response.status}`),
      )
      error.statusCode = isHermesRateLimit(response.status, body) ? 503 : response.status
      throw error
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let parsed
        try { parsed = JSON.parse(payload) } catch { continue }
        const delta = parsed?.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) {
          full += delta
          onDelta(delta)
        }
      }
    }
    return { content: full.trim() }
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (options.signal?.aborted) {
        const stopped = new Error('Run stopped.')
        stopped.code = 'RUN_STOPPED'
        throw stopped
      }
      const timeoutError = new Error('Hermes took too long to respond.')
      timeoutError.statusCode = 504
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function chatWithHermes(agentId, messages, options = {}) {
  const { baseUrl, apiKey } = getHermesConfig()
  const baseInstructions = typeof options.instructions === 'string'
    ? options.instructions
    : (await getAgentChatInstructions(agentId)).instructions
  const suppliedMemoryContext = typeof options.memoryContext === 'string'
  const memory = suppliedMemoryContext
    ? null
    : await retrieveMemoryContext({ agentId, messages, user: options.user })
  const memoryContext = suppliedMemoryContext
    ? options.memoryContext.trim()
    : memory.context
  const memoryMeta = options.memoryMeta || (memory
    ? { status: memory.status, retrieved: memory.memories.length }
    : undefined)
  const instructions = memoryContext
    ? `${baseInstructions}\n\n${memoryContext}`
    : baseInstructions
  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs || REQUEST_TIMEOUT_MS)
  const rateLimitRetries = Number.isFinite(Number(options.rateLimitRetries))
    ? Math.max(0, Number(options.rateLimitRetries))
    : RATE_LIMIT_RETRIES
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abortFromCaller = () => controller.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    let payload
    let content = ''
    for (let attempt = 0; attempt <= rateLimitRetries; attempt += 1) {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_HERMES_MODEL,
          messages: [
            { role: 'system', content: instructions },
            ...messages.map(({ role, content }) => ({ role, content })),
          ],
          stream: false,
        }),
        signal: controller.signal,
      })

      const body = await response.text()
      if (response.ok) {
        try {
          payload = JSON.parse(body)
        } catch {
          payload = null
        }
        content = getHermesContent(payload)
        if (isHermesRateLimit(response.status, content) && attempt < rateLimitRetries) {
          await waitForRetry(getHermesRetryDelayMs(content, attempt), controller.signal)
          continue
        }
        if (isHermesRateLimit(response.status, content)) {
          const error = new Error('The HubSpot query is still processing. Please retry shortly.')
          error.statusCode = 503
          throw error
        }
        break
      }

      if (isHermesRateLimit(response.status, body) && attempt < rateLimitRetries) {
        await waitForRetry(getHermesRetryDelayMs(body, attempt), controller.signal)
        continue
      }

      const error = new Error(
        isHermesRateLimit(response.status, body)
          ? 'The HubSpot query is still processing. Please retry shortly.'
          : (body || `Hermes request failed with ${response.status}`),
      )
      error.statusCode = isHermesRateLimit(response.status, body) ? 503 : response.status
      throw error
    }

    if (!content) {
      const error = new Error('Hermes returned an empty response.')
      error.statusCode = 502
      throw error
    }

    return {
      message: {
        role: 'assistant',
        content,
      },
      meta: {
        provider: 'hermes',
        model: payload.model || DEFAULT_HERMES_MODEL,
        responseId: payload.id || '',
        memory: memoryMeta,
      },
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (options.signal?.aborted) {
        const stoppedError = new Error('Run stopped by user.')
        stoppedError.code = 'RUN_STOPPED'
        throw stoppedError
      }
      const timeoutError = new Error('Hermes took too long to respond.')
      timeoutError.statusCode = 504
      throw timeoutError
    }

    throw error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}
