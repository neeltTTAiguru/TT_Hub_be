import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { getAgentById, listAgents } from './agentCatalog.js'
import { runAgentChat, sanitizeChatMessages } from './agentRunner.js'

/**
 * The hub as an MCP server -- the return path from Hermes into the hub.
 *
 * The hub already calls Hermes (hermesChat.js, the Orchestrator proxy). This is
 * the other direction: Hermes Operations, its crons and its kanban get the
 * hub's agents as tools, so "ask the HubSpot assistant for this week's deals"
 * works from the dashboard the same way clicking the agent does.
 *
 * Deliberately narrow. Two tools, both routed through the same agentRunner the
 * UI uses, so an agent reached from Hermes carries its own SKILL.md, its GBrain
 * memory and its tool filters, and no hub endpoint is exposed that a person
 * could not already reach from the agent page.
 */

// Who the memory layer and the "saved by" stamps see. A service identity with
// no permissions claim: getMemoryScope then grants the public sensitivities
// only, so a cron cannot surface a confidential page that a person would need
// `memory:confidential` to read.
export const HUB_MCP_ACTOR_ID = 'hermes-operations'

export function getHubMcpActor() {
  const email = String(process.env.HUB_MCP_ACTOR_EMAIL || 'hermes-operations@trustedtechnology.ai')
    .trim()
    .toLowerCase()
  return { id: HUB_MCP_ACTOR_ID, email, payload: { sub: HUB_MCP_ACTOR_ID, permissions: [] } }
}

/**
 * Bearer-key check. Fails closed: no HUB_MCP_KEY on the backend means the
 * endpoint answers nobody, the same stance HERMES_DASHBOARD_ALLOWED_EMAILS takes
 * -- a key that is "unset" must never read as "open".
 */
export function hubMcpKeyAccepted(authorizationHeader = '', configuredKey = process.env.HUB_MCP_KEY) {
  const expected = String(configuredKey || '').trim()
  if (!expected) return false
  const header = String(authorizationHeader || '')
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  if (!presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Prior turns a caller may carry: enough for a follow-up, not a transcript.
const MAX_HISTORY_TURNS = 11

const historySchema = z
  .array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(20000),
    }),
  )
  .max(MAX_HISTORY_TURNS)
  .optional()

function agentSummary(agent) {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    productArea: agent.productArea,
    summary: agent.summary,
  }
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/**
 * A server per request. The transport runs stateless (no session id), so a
 * Hermes cron that fires once a day and a chat that fires every few seconds
 * are handled identically, and nothing accumulates in memory between calls.
 */
export function createHubMcpServer({ run = runAgentChat, agents = listAgents, agent = getAgentById } = {}) {
  const server = new McpServer({ name: 'trusted-tech-hub', version: '1.0.0' })

  server.registerTool(
    'list_agents',
    {
      title: 'List hub agents',
      description:
        'The Trusted Tech Hub agents that ask_agent can talk to: id, name, status, product area and a one-line summary. Call this first if you are unsure which agent_id to use.',
      inputSchema: {},
    },
    async () => {
      const all = await agents()
      const active = all.filter((item) => item.status === 'active').map(agentSummary)
      return {
        content: [{ type: 'text', text: JSON.stringify(active, null, 2) }],
        structuredContent: { agents: active },
      }
    },
  )

  server.registerTool(
    'ask_agent',
    {
      title: 'Ask a hub agent',
      description:
        'Send one message to a Trusted Tech Hub agent and get its reply. The agent answers with its own hub instructions, memory and tools -- exactly as it would from the hub UI. Pass history to continue an earlier exchange with the same agent. One message, one reply; call again to follow up.',
      inputSchema: {
        agent_id: z.string().min(1).describe('An id from list_agents, e.g. trusted-tech-hubspot-assistant'),
        message: z.string().min(1).max(20000).describe('What to ask the agent'),
        history: historySchema.describe('Earlier user/assistant turns with this agent, oldest first'),
      },
    },
    async ({ agent_id: agentId, message, history }) => {
      const target = await agent(agentId)
      if (!target) return toolError(`Unknown agent "${agentId}". Call list_agents for the valid ids.`)
      if (target.status !== 'active') return toolError(`Agent "${agentId}" is ${target.status}, not active.`)

      const messages = sanitizeChatMessages([...(history || []), { role: 'user', content: message }])
      try {
        const result = await run({ agentId, messages, user: getHubMcpActor() })
        const reply = String(result?.message?.content || '')
        return {
          content: [{ type: 'text', text: reply }],
          structuredContent: {
            agent_id: agentId,
            agent_name: target.name,
            reply,
            meta: result?.meta || {},
          },
        }
      } catch (error) {
        return toolError(`${target.name} could not answer: ${error?.message || 'unknown error'}`)
      }
    },
  )

  return server
}

export async function handleHubMcpRequest(req, res, deps) {
  const server = createHubMcpServer(deps)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    transport.close().catch(() => {})
    server.close().catch(() => {})
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
