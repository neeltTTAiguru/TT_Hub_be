import mongoose from 'mongoose'
import CompanyContext from '../models/CompanyContext.js'
import Competitor from '../models/Competitor.js'
import Product from '../models/Product.js'
import PublicPage from '../models/PublicPage.js'
import ResearchRun from '../models/ResearchRun.js'
import Opportunity from '../models/Opportunity.js'
import GrantOpportunity from '../models/GrantOpportunity.js'
import { getAgentById } from './agentCatalog.js'
import { buildKnowledgeContext } from './knowledgeContext.js'
import { getGa4Snapshot } from './ga4Analytics.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

function isMongoConnected() {
  return mongoose.connection.readyState === 1
}

function cleanList(items, fallback = 'None recorded') {
  const values = items.filter(Boolean)
  return values.length ? values.join(', ') : fallback
}

function stringifyDocument(value) {
  if (!value) return 'Not available'
  if (typeof value === 'string') return value.trim() || 'Not available'

  return JSON.stringify(value, null, 2)
}

function getTextFromResponse(payload) {
  if (!Array.isArray(payload?.output)) {
    return ''
  }

  return payload.output
    .flatMap((item) => {
      if (item?.type !== 'message' || !Array.isArray(item.content)) {
        return []
      }

      return item.content
        .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
        .map((content) => content.text)
    })
    .join('\n')
    .trim()
}

async function loadLiveWorkspaceContext() {
  const ga4SnapshotPromise = getGa4Snapshot().catch((error) => ({
    unavailable: true,
    message: error.message,
  }))

  if (!isMongoConnected()) {
    return {
      companyContext: null,
      competitors: [],
      products: [],
      publicPages: [],
      researchRuns: [],
      grantOpportunities: [],
      ga4Snapshot: await ga4SnapshotPromise,
    }
  }

  const [companyContext, competitors, products, publicPages, researchRuns, opportunities, grantOpportunities, knowledgeContext, ga4Snapshot] = await Promise.all([
    CompanyContext.findOne().lean(),
    Competitor.find().sort({ updatedAt: -1 }).limit(8).lean(),
    Product.find({ visibility: 'public' }).sort({ updatedAt: -1 }).limit(12).lean(),
    PublicPage.find({ visibility: 'public' }).sort({ updatedAt: -1 }).limit(12).lean(),
    ResearchRun.find().sort({ updatedAt: -1 }).limit(6).lean(),
    Opportunity.find().sort({ updatedAt: -1 }).limit(12).lean(),
    GrantOpportunity.find().sort({ fitScore: -1, updatedAt: -1 }).limit(12).lean(),
    buildKnowledgeContext('Trusted Technology T500 body camera docking Trusted Vault evidence management', 36),
    ga4SnapshotPromise,
  ])

  return {
    companyContext,
    competitors,
    products,
    publicPages,
    researchRuns,
    opportunities,
    grantOpportunities,
    knowledgeContext,
    ga4Snapshot,
  }
}

function buildInstructions(agent, liveContext) {
  const competitorLines = liveContext.competitors.length
    ? liveContext.competitors
        .map((competitor) => {
          const signals = competitor.watchSignals?.length
            ? ` Signals: ${competitor.watchSignals.join('; ')}.`
            : ''

          return `- ${competitor.name} (${competitor.status}, ${competitor.category}). Notes: ${
            competitor.notes || 'None'
          }. Strengths: ${cleanList(competitor.strengths)}.${signals}`
        })
        .join('\n')
    : '- No tracked competitors are stored yet.'

  const runLines = liveContext.researchRuns.length
    ? liveContext.researchRuns
        .map(
          (run) =>
            `- ${run.title} [${run.status}] Objective: ${run.objective}. Summary: ${
              run.reportSummary || 'No summary yet'
            }. Findings: ${run.findings?.length || 0}.`,
        )
        .join('\n')
    : '- No prior research runs are stored yet.'

  const productLines = liveContext.products.length
    ? liveContext.products
        .map(
          (product) =>
            `- ${product.name} (${product.category}). Summary: ${product.summary}. Markets: ${cleanList(
              product.targetMarkets,
            )}. Features: ${cleanList(product.features)}. Claims: ${cleanList(product.claims)}.`,
        )
        .join('\n')
    : '- No public products are stored yet.'

  const publicPageLines = liveContext.publicPages.length
    ? liveContext.publicPages
        .map(
          (page) =>
            `- ${page.title} [${page.pageType}] ${page.url}. Summary: ${page.summary}. Highlights: ${cleanList(
              page.highlights,
            )}.`,
        )
        .join('\n')
    : '- No public website pages are stored yet.'

  const opportunityLines = liveContext.opportunities?.length
    ? liveContext.opportunities
        .map(
          (opportunity) =>
            `- ${opportunity.title} | Agency: ${opportunity.agency || 'Unknown'} | Posted: ${
              opportunity.postedDate || 'Unknown'
            } | Deadline: ${opportunity.responseDeadline || 'Unknown'} | Type: ${
              opportunity.noticeType || 'Unknown'
            } | Set-aside: ${opportunity.setAside || 'None listed'} | Link: ${opportunity.uiLink || 'None'}.`,
        )
        .join('\n')
    : '- No SAM.gov opportunities are stored yet.'

  const grantOpportunityLines = liveContext.grantOpportunities?.length
    ? liveContext.grantOpportunities
        .map(
          (opportunity) =>
            `- ${opportunity.title} | Source: ${opportunity.sourceAgency || 'Unknown'} | Fit score: ${
              opportunity.fitScore || 0
            } | Deadline: ${opportunity.deadline || 'Unknown'} | Award: ${
              opportunity.awardRange || 'Unknown'
            } | Eligibility: ${opportunity.eligibility || 'Unknown'} | Link: ${
              opportunity.applicationUrl || opportunity.sourceUrl || 'None'
            }.`,
        )
        .join('\n')
    : '- No available grant opportunities are stored yet.'

  return [
    'You are Trusted Tech Smart Hub, Trusted Tech\'s internal AI operating assistant.',
    'Treat company information as internal by default.',
    'Ask before taking actions that publish, contact anyone outside Trusted Tech, or change an external system.',
    'Separate known facts, assumptions, and recommendations.',
    'Speak naturally and conversationally, like a warm, capable teammate.',
    'For greetings, follow-up questions, and ordinary chat, answer directly in plain prose without headings, labels, or a fixed template.',
    'Do not prefix responses with labels such as "Known Context", "Answer or Recommendation", "Open Questions", or "Suggested Next Steps".',
    'Use headings or structured lists only when they genuinely make a research result, comparison, plan, or complex answer easier to understand.',
    'Keep answers concise by default and ask a natural follow-up question when useful.',
    'When making market claims, prefer citing sources as markdown links when the user asks for external research.',
    'Do not invent company facts or claim a source was checked if it was not provided in the chat.',
    'Brand asset rule: the approved and canonical Trusted Technology logo is beCRM/assets/brand/PRIMARY_Logo.pdf.',
    // Brain-write policy. Agent-wide rules live here rather than in a workspace
    // markdown file: the old scaffold resolved one level ABOVE the backend, so on
    // the deployed app it loaded as '' with ENOENT swallowed and never applied.
    // Anything an agent must always obey has to ship inside beCRM.
    'Saving to the Brain: when the user tells you to save something to the Brain -- "save this", "remember this", "put that in <section>" -- save it yourself with the gbrain put_page tool. Their instruction is the confirmation. Never tell them to use a button, never say you will save it once they confirm, and never offer to save instead of saving.',
    'Never write to the Brain unprompted, and never save raw conversation transcripts. The Brain holds approved knowledge, not chat logs.',
    'Every page you write MUST carry YAML frontmatter with title, lifecycle: approved, sensitivity (internal or public), and departments (shared, sales, marketing, operations, or research). A page without lifecycle: approved is rejected by retrieval and by the Brain UI -- it looks saved to you and is invisible to everyone else.',
    'Set allowed_agents to the agent id owning that section (for example allowed_agents: [content-operations-assistant]); an agent chat only retrieves memories that name it. Omit allowed_agents entirely for company-wide knowledge.',
    'Slugs follow the Brain conventions: tt-shared/<topic>/<name> for company-wide knowledge, <agent-id>/<topic>/<name> for a section. put_page overwrites silently, so before writing to a slug that may exist, call resolve_slugs and get_page and update that page rather than creating a near-duplicate.',
    'After saving, tell the user the exact slug and title you wrote and whether it created or updated a page. If the write fails, say so with the error -- never report a save you did not verify.',
    'Whenever a Trusted Technology logo is needed, use that asset as the source of truth. Never redraw, regenerate, recolor, distort, crop, rearrange, or substitute it.',
    'If a destination cannot use PDF directly, derive the required format from the canonical PDF while preserving the complete lockup, proportions, colors, clear space, and legibility.',
    'Do not invent compact, monochrome, reversed, or icon-only logo variants. If the canonical asset is unavailable to the executing tool, state that limitation instead of fabricating a logo.',
    '',
    `Agent: ${agent.name}`,
    `Mission: ${agent.mission}`,
    `Workflow: ${agent.workflow.join(' | ')}`,
    `Output shape: ${agent.outputShape.join(' | ')}`,
    '',
    'Skill:',
    stringifyDocument(agent.documents.skill.content),
    '',
    'Live company context:',
    stringifyDocument(liveContext.companyContext),
    '',
    'Tracked competitors:',
    competitorLines,
    '',
    'Public products:',
    productLines,
    '',
    'Public website pages:',
    publicPageLines,
    '',
    'Approved Trusted Tech knowledge base:',
    liveContext.knowledgeContext || 'No approved knowledge records are stored yet.',
    'Records marked VERIFY/CITE BEFORE ASSERTING may inform research but must not be stated as current fact without verification or a source citation.',
    '',
    'SAM.gov opportunities:',
    opportunityLines,
    '',
    'Available grant opportunities:',
    grantOpportunityLines,
    '',
    'Recent research runs:',
    runLines,
    '',
    'GA4 website analytics (read-only snapshot):',
    stringifyDocument(liveContext.ga4Snapshot),
    'Treat GA4 metrics as time-bounded measurements. State the reporting period whenever using them.',
  ].join('\n')
}

// A message's content may be a multimodal array (text + image parts) when the
// user attached images. This Responses-API path is the OpenAI fallback and
// doesn't take chat-completions image parts, so flatten to text (keeping any
// extracted document text) and note that images weren't analyzed here.
function flattenContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
    const imageCount = content.filter((part) => part?.type === 'image_url').length
    let out = texts.join('\n')
    if (imageCount) out += `${out ? '\n' : ''}[${imageCount} image(s) attached — not analyzed on this path]`
    return out
  }
  return String(content ?? '')
}

function toOpenAIInput(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: flattenContent(message.content),
  }))
}

export async function getAgentChatInstructions(agentId) {
  const agent = await getAgentById(agentId)

  if (!agent) {
    const error = new Error('Agent not found')
    error.statusCode = 404
    throw error
  }

  const liveContext = await loadLiveWorkspaceContext()

  return {
    agent,
    instructions: buildInstructions(agent, liveContext),
  }
}

export async function chatWithAgent(agentId, messages, options = {}) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is not configured on the backend.')
    error.statusCode = 503
    throw error
  }

  const { instructions: catalogInstructions } = await getAgentChatInstructions(agentId)
  const baseInstructions = typeof options.instructions === 'string' ? options.instructions : catalogInstructions
  const memoryContext = typeof options.memoryContext === 'string' ? options.memoryContext.trim() : ''
  const instructions = memoryContext ? `${baseInstructions}\n\n${memoryContext}` : baseInstructions

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      instructions,
      input: toOpenAIInput(messages),
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    const error = new Error(body || `OpenAI request failed with ${response.status}`)
    error.statusCode = response.status
    throw error
  }

  const payload = await response.json()
  const content = getTextFromResponse(payload)

  if (!content) {
    const error = new Error('OpenAI returned an empty response.')
    error.statusCode = 502
    throw error
  }

  return {
    message: {
      role: 'assistant',
      content,
    },
    meta: {
      provider: 'openai',
      model: payload.model || DEFAULT_MODEL,
      responseId: payload.id || '',
      memory: options.memoryMeta || undefined,
    },
  }
}

export async function chatWithOpenAIInstructions(messages, instructions) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is not configured on the backend.')
    error.statusCode = 503
    throw error
  }
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: DEFAULT_MODEL, instructions, input: toOpenAIInput(messages) }),
  })
  if (!response.ok) {
    const body = await response.text()
    const error = new Error(body || `OpenAI request failed with ${response.status}`)
    error.statusCode = response.status
    throw error
  }
  const payload = await response.json()
  const content = getTextFromResponse(payload)
  if (!content) throw Object.assign(new Error('OpenAI returned an empty response.'), { statusCode: 502 })
  return {
    message: { role: 'assistant', content },
    meta: { provider: 'openai-fallback', model: payload.model || DEFAULT_MODEL, responseId: payload.id || '' },
  }
}
