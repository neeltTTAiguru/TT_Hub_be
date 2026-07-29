import { getAgentChatInstructions } from './openaiChat.js'

const DEFAULT_HERMES_MODEL = process.env.HERMES_MODEL || 'hermes-agent'
const REQUEST_TIMEOUT_MS = Number(process.env.HERMES_REQUEST_TIMEOUT_MS || 120000)

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

export async function chatWithHermes(agentId, messages) {
  const { baseUrl, apiKey } = getHermesConfig()
  const { instructions } = await getAgentChatInstructions(agentId)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
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

    if (!response.ok) {
      const body = await response.text()
      const error = new Error(body || `Hermes request failed with ${response.status}`)
      error.statusCode = response.status
      throw error
    }

    const payload = await response.json()
    const content = getHermesContent(payload)

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
      },
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Hermes took too long to respond.')
      timeoutError.statusCode = 504
      throw timeoutError
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}
