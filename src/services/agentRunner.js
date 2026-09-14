import { chatWithHermes } from './hermesChat.js'
import { chatWithAgent } from './openaiChat.js'
import { handleWordPressChat } from './wordpressDraftEditor.js'
import { retrieveMemoryContext } from './memoryGateway.js'
import { chatWithHubSpotDeals } from './hubspotDeals.js'
import { chatWithYouTrack } from './youtrack.js'
import { applySaveRequests } from './brainSave.js'

// Prefer Hermes (same backend as Brain), but bound how long we wait on it: if
// Hermes is slow or offline, fall back to the fast OpenAI-backed chat instead of
// hanging until the gateway times out (~2 min). Used by Competitor Analyst.
const COMPETITOR_HERMES_TIMEOUT_MS = Number(process.env.COMPETITOR_HERMES_TIMEOUT_MS || 25000)

// Agents whose replies are scanned for save blocks. Matches MEMORY_WRITERS in
// memoryGateway -- no other agent can write, so no other agent's output needs
// parsing.
export const SAVE_CAPABLE_AGENTS = new Set(['trusted-tech-assistant', 'competitor-analyst'])

const HERMES_AGENTS = new Set([
  'trusted-tech-assistant',
  'trusted-tech-hubspot-assistant',
  'trusted-tech-youtrack-assistant',
  'trusted-tech-ahrefs-assistant',
  'content-operations-assistant',
  'wordpress-draft-test-agent',
])

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

// Keeps the raw text out of every log line, and the sanitising in one place so
// the HTTP route and the MCP tool cannot drift apart on what counts as a turn.
export function sanitizeChatMessages(messages, limit = 12) {
  return (Array.isArray(messages) ? messages : [])
    .filter(
      (message) =>
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim(),
    )
    .slice(-limit)
}

/**
 * One turn with a hub agent, exactly as the hub UI runs it.
 *
 * This is the single dispatch table: which agent goes to Hermes, which to its
 * own tool-backed service, which falls back to OpenAI. Both POST /agents/:id/chat
 * and the hub MCP server's `ask_agent` call this, so a caller in Hermes
 * Operations gets the same instructions, memory retrieval, save handling and
 * timeouts a person clicking the agent gets -- no second, drifting copy.
 *
 * `messages` are the plain-text turns memory retrieval reads; `chatMessages`
 * are what the model sees (the route enriches the last one with attachments).
 */
export async function runAgentChat({ agentId, messages, chatMessages = messages, user, competitor = '' }) {
  const memory = await retrieveMemoryContext({ agentId, messages, user, competitor })
  const memoryOptions = {
    memoryContext: memory.context,
    memoryMeta: {
      status: memory.status,
      retrieved: memory.memories.length,
    },
  }

  const result = agentId === 'trusted-tech-hubspot-assistant'
    ? await chatWithHubSpotDeals(chatMessages, memoryOptions)
    : agentId === 'trusted-tech-youtrack-assistant'
    ? await chatWithYouTrack(chatMessages, memoryOptions)
    : agentId === 'wordpress-draft-editor'
    ? await handleWordPressChat(chatMessages, memoryOptions)
    : agentId === 'competitor-analyst'
    ? await chatWithHermesOrOpenAI(agentId, chatMessages, memoryOptions)
    : HERMES_AGENTS.has(agentId)
      ? await chatWithHermes(agentId, chatMessages, memoryOptions)
      : await chatWithAgent(agentId, chatMessages, memoryOptions)

  if (SAVE_CAPABLE_AGENTS.has(agentId) && result?.message?.content) {
    const applied = await applySaveRequests({ agentId, user, content: result.message.content })
    result.message.content = applied.content
    result.meta = { ...(result.meta || {}), saved: applied.saved, saveFailed: applied.failed }
  }
  result.meta = { ...(result.meta || {}), memory: memoryOptions.memoryMeta }
  return result
}
