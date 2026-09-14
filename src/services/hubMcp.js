import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { getAgentById, listAgents } from './agentCatalog.js'
import { runAgentChat, sanitizeChatMessages } from './agentRunner.js'
import {
  DEFAULT_MAP_TIMEZONE,
  mapAgency,
  mapCallActivity,
  mapRecentCalls,
  mapResearchRuns,
  mapSearchAgencies,
} from './agencyMapTools.js'

/**
 * The hub as an MCP server -- the return path from Hermes into the hub.
 *
 * The hub already calls Hermes (hermesChat.js, the Orchestrator proxy). This is
 * the other direction: Hermes Operations, its crons and its kanban get the
 * hub's agents as tools, so "ask the HubSpot assistant for this week's deals"
 * works from the dashboard the same way clicking the agent does.
 *
 * Deliberately narrow. The agent tools route through the same agentRunner the
 * UI uses, so an agent reached from Hermes carries its own SKILL.md, its GBrain
 * memory and its tool filters. The map tools are read-only views of the Agency
 * Map (agencyMapTools.js). No hub endpoint is exposed that a person could not
 * already reach from the hub, and nothing here spends money or writes.
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

// structuredContent must be an object, so a list is wrapped rather than sent bare.
function jsonResult(value) {
  const structured = Array.isArray(value) ? { items: value } : value
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

// Shared by every map tool that takes a time window.
const windowSchema = {
  from: z
    .string()
    .optional()
    .describe('Start of the window: YYYY-MM-DD (a whole day in `timezone`) or an ISO instant. Default: 30 days ago'),
  to: z.string().optional().describe('End of the window, same forms. Default: now'),
  timezone: z
    .string()
    .optional()
    .describe(`IANA zone that bare dates are read in. Default ${DEFAULT_MAP_TIMEZONE} (the SDR team)`),
}

// The map's own filter vocabulary, so a scope Hermes asks for is exactly a
// scope the map can show.
const territorySchema = {
  state: z.string().optional().describe('Two-letter state codes, comma-separated, e.g. "TX" or "TX,OK,NM"'),
  agencyType: z.string().optional().describe('Comma-separated agency types as the map lists them, e.g. "Sheriff"'),
  search: z.string().optional().describe('Agency name contains this text (case-insensitive)'),
  minOfficers: z.number().int().optional().describe('Minimum sworn officers'),
  maxOfficers: z.number().int().optional().describe('Maximum sworn officers'),
  bwc: z.enum(['true', 'false', 'unknown']).optional().describe('Body-worn cameras: known to have, known to have none, or undocumented'),
  crm: z.enum(['matched', 'unmatched']).optional().describe('In the HubSpot pipeline, or never touched'),
}

/**
 * A server per request. The transport runs stateless (no session id), so a
 * Hermes cron that fires once a day and a chat that fires every few seconds
 * are handled identically, and nothing accumulates in memory between calls.
 */
export function createHubMcpServer({
  run = runAgentChat,
  agents = listAgents,
  agent = getAgentById,
  map = { callActivity: mapCallActivity, recentCalls: mapRecentCalls, searchAgencies: mapSearchAgencies, agency: mapAgency, researchRuns: mapResearchRuns },
} = {}) {
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

  server.registerTool(
    'map_call_activity',
    {
      title: 'Agency Map call activity',
      description:
        'Counted call activity from the Agency Map call log for a territory and time window: totals (calls, agencies rung, conversations, decision makers reached), calls per day, per outcome, per state, per SDR (bySdr, keyed by the email they logged with), most-worked agencies, follow-ups booked, and the notes SDRs typed after each call. This is where "how many calls did Troy make today" is answered -- the HubSpot agent cannot see it. The numbers are already counted; quote them, do not recompute.',
      inputSchema: { ...windowSchema, ...territorySchema },
    },
    async (args) => jsonResult(await map.callActivity(args)),
  )

  server.registerTool(
    'map_recent_calls',
    {
      title: 'Agency Map recent calls',
      description:
        'Individual calls from the Agency Map call log, newest first: which agency, when, who answered, outcome, follow-up date, the note, and which SDR logged it. Filter to one SDR with `sdr` (matches the email they signed in with, e.g. "troy").',
      inputSchema: {
        ...windowSchema,
        ...territorySchema,
        sdr: z.string().optional().describe('Only calls logged by an SDR whose email contains this text'),
        limit: z.number().int().min(1).max(200).optional().describe('Max calls to return (default 50)'),
      },
    },
    async (args) => jsonResult(await map.recentCalls(args)),
  )

  server.registerTool(
    'map_search_agencies',
    {
      title: 'Search Agency Map',
      description:
        'Law-enforcement agencies on the Agency Map matching the map\'s own filters, largest first: ORI, name, type, state, county, sworn officers, HubSpot stage, body-camera status and vendor, chief, phone, email, website, and outreach summary (calls made, last outcome). Use the ORI with map_agency for the full record.',
      inputSchema: {
        ...territorySchema,
        limit: z.number().int().min(1).max(100).optional().describe('Max agencies to return (default 25)'),
      },
    },
    async (args) => jsonResult(await map.searchAgencies(args)),
  )

  server.registerTool(
    'map_agency',
    {
      title: 'Agency Map agency',
      description: 'One agency by ORI with its full call log, newest call first.',
      inputSchema: { ori: z.string().min(1).describe('The agency ORI, e.g. TX2200000') },
    },
    async ({ ori }) => {
      const found = await map.agency({ ori })
      return found ? jsonResult(found) : toolError(`No agency with ORI "${ori}".`)
    },
  )

  server.registerTool(
    'map_research_runs',
    {
      title: 'Agency Map research runs',
      description:
        'Body-camera research runs on the Agency Map, newest first: status, targeting, how many agencies were covered, and what was found (cameras, emails, phones). Read-only -- runs are started from the hub by full-access users, never from here.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Max runs (default 20)') },
    },
    async (args) => jsonResult(await map.researchRuns(args)),
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
