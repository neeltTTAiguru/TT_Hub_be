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
import { createMailAgent } from './mailAgent.js'
import { webResearch } from './webResearch.js'

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
 * already reach from the hub, and nothing here spends money.
 *
 * The one exception to read-only is the mail agent (mailAgent.js): it sends
 * email as MAIL_AGENT_MAILBOX, and only exists when that is set. Its
 * guardrails live in that file, not in the tool descriptions.
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
  mail = createMailAgent(),
  research = webResearch,
} = {}) {
  const server = new McpServer({ name: 'trusted-tech-hub', version: '1.0.0' })

  server.registerTool(
    'list_agents',
    {
      title: 'List hub agents',
      description:
        'The Trusted Tech Hub agents that ask_agent can talk to: id, name, status, product area and a one-line summary. Call this first if you are unsure which agent_id to use. NOT for Agency Map / MAP call data -- use the map_* tools for calls, SDR activity and agencies.',
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
        'Send one message to a Trusted Tech Hub agent and get its reply. The agent answers with its own hub instructions, memory and tools -- exactly as it would from the hub UI. Pass history to continue an earlier exchange with the same agent. One message, one reply; call again to follow up. NOT for Agency Map / MAP calls: no agent can see the call log -- use map_call_activity or map_calls_by_sdr for that.',
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
        'MAP calls / Agency Map call activity. The ONLY source for questions like "how many MAP calls did Troy and Neil make today" -- the call log lives in the hub, not HubSpot, and no agent can see it. Returns counted activity for a territory and time window: totals (calls, agencies rung, conversations, decision makers reached), calls per day, per outcome, per state, per SDR (byRep, keyed by the email they logged with), most-worked agencies, follow-ups booked, and the notes SDRs typed after each call. Always call this rather than answering from memory. The numbers are already counted; quote them, do not recompute.',
      inputSchema: { ...windowSchema, ...territorySchema },
    },
    async (args) => jsonResult(await map.callActivity(args)),
  )

  server.registerTool(
    'map_calls_by_sdr',
    {
      title: 'MAP calls per SDR',
      description:
        'How many MAP (Agency Map) calls each SDR made in a window, by name/email: calls, agencies rung, conversations, decision makers reached. The direct answer to "how many MAP calls did Troy and Neil make today / this week". An SDR with no row made no calls in that window. Defaults to today in the SDR team\'s timezone.',
      inputSchema: { ...windowSchema, ...territorySchema },
    },
    async (args) => {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: args.timezone || DEFAULT_MAP_TIMEZONE })
      const stats = await map.callActivity({ from: today, to: today, ...args })
      return jsonResult({
        period: stats.period,
        scope: stats.scope,
        totalCalls: stats.totals?.calls ?? 0,
        bySdr: (stats.byRep || []).map((row) => ({
          sdr: row.rep,
          calls: row.calls,
          agencies: row.agencies,
          conversations: row.conversations,
          decisionMakers: row.decisionMakers,
        })),
      })
    },
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

  server.registerTool(
    'web_research',
    {
      title: 'Web research',
      description:
        'Search the web and read the pages to answer one question, with cited source URLs. Use this for anything that needs current information from the internet (vendors, agencies, products, news, grants, people, prices on public sites). It really browses; prefer it over your own web tools and over hub agents for web questions. Takes a few minutes.',
      inputSchema: {
        question: z.string().min(1).max(2000).describe('What to find out, as a full question'),
        context: z.string().max(4000).optional().describe('Background that narrows the search, e.g. the email it came from'),
      },
    },
    async (args) => {
      try {
        return jsonResult(await research(args))
      } catch (error) {
        return toolError(error?.message || 'Web research failed.')
      }
    },
  )

  if (mail) registerMailTools(server, mail)

  return server
}

// A thrown guardrail is an answer Hermes should read and act on, not a crash.
const mailCall = (fn) => async (args) => {
  try {
    return jsonResult(await fn(args))
  } catch (error) {
    return toolError(error?.message || 'The mail agent failed.')
  }
}

function registerMailTools(server, mail) {
  const mailbox = mail.config.mailbox
  const messageId = z.string().min(1).describe('message_id from mail_next_batch')

  server.registerTool(
    'mail_next_batch',
    {
      title: 'Mail agent: next emails',
      description: `The next new emails in ${mailbox}'s inbox for the mail agent to handle, oldest first, with instructions. Newsletters, notifications and other automated mail are already filtered out. Each email is claimed for you: settle EVERY one with mail_reply, mail_notify_neel or mail_skip. When "more" is true, call again after settling these. Empty "emails" means nothing to do.`,
      inputSchema: { max: z.number().int().min(1).max(10).optional().describe('Emails per batch (default 5)') },
    },
    mailCall((args) => mail.nextBatch(args)),
  )

  server.registerTool(
    'mail_reply',
    {
      title: 'Mail agent: reply',
      description: `Reply to one email as ${mailbox}, in its thread, to its sender. Use it when can_auto_reply was true and you answered the question or did the task (including research you just did), or when Neel told you to reply in instructions_from_neel. Plain text, signed "Neel". In trial mode the reply is emailed to Neel as "would reply" instead of to the sender. A refusal means: call mail_notify_neel instead.`,
      inputSchema: {
        message_id: messageId,
        body: z.string().min(1).max(5000).describe('The reply text, plain, signed "Neel"'),
      },
    },
    mailCall((args) => mail.reply(args)),
  )

  server.registerTool(
    'mail_notify_neel',
    {
      title: 'Mail agent: hand to Neel',
      description: 'Hand one email to Neel instead of replying: emails him who it is from, a short summary, why it needs him, and an optional suggested reply. Use for anything you cannot answer or do with your tools, and for pricing, commitments, complaints, internal data for outsiders, or first-time senders. Research and lookup requests are NOT a reason to notify: do the research and mail_reply. Neel answers by replying to this email; his reply comes back as an instruction.',
      inputSchema: {
        message_id: messageId,
        summary: z.string().min(1).max(2000).describe('Two lines: who they are and what they want'),
        reason: z.string().min(1).max(1000).describe('Why the agent did not reply itself'),
        suggested_reply: z.string().max(5000).optional().describe('A reply Neel could send, if you have one'),
        holding_reply: z.string().max(5000).optional().describe('For always_reply emails: a short reply sent to the sender now, e.g. "Got it, I\'ll come back to you on pricing today." Signed "Neel".'),
      },
    },
    mailCall((args) => mail.notify(args)),
  )

  server.registerTool(
    'mail_skip',
    {
      title: 'Mail agent: no response needed',
      description: 'Settle an email that needs no response at all (a thank-you, an FYI, an acknowledgement). Not for emails you could not answer -- those go to mail_notify_neel. Refused for always_reply emails: acknowledge those with mail_reply.',
      inputSchema: {
        message_id: messageId,
        reason: z.string().min(1).max(500).describe('Why no response is needed'),
      },
    },
    mailCall((args) => mail.skip(args)),
  )
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
