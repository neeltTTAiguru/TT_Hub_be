import mongoose from 'mongoose'
import CompanyContext from '../models/CompanyContext.js'
import Competitor from '../models/Competitor.js'
import Product from '../models/Product.js'
import PublicPage from '../models/PublicPage.js'
import ResearchRun from '../models/ResearchRun.js'
import Opportunity from '../models/Opportunity.js'
import GrantOpportunity from '../models/GrantOpportunity.js'
import { getAgentById } from './agentCatalog.js'

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
  if (!isMongoConnected()) {
    return {
      companyContext: null,
      competitors: [],
      products: [],
      publicPages: [],
      researchRuns: [],
      grantOpportunities: [],
    }
  }

  const [companyContext, competitors, products, publicPages, researchRuns, opportunities, grantOpportunities] = await Promise.all([
    CompanyContext.findOne().lean(),
    Competitor.find().sort({ updatedAt: -1 }).limit(8).lean(),
    Product.find({ visibility: 'public' }).sort({ updatedAt: -1 }).limit(12).lean(),
    PublicPage.find({ visibility: 'public' }).sort({ updatedAt: -1 }).limit(12).lean(),
    ResearchRun.find().sort({ updatedAt: -1 }).limit(6).lean(),
    Opportunity.find().sort({ updatedAt: -1 }).limit(12).lean(),
    GrantOpportunity.find().sort({ fitScore: -1, updatedAt: -1 }).limit(12).lean(),
  ])

  return {
    companyContext,
    competitors,
    products,
    publicPages,
    researchRuns,
    opportunities,
    grantOpportunities,
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
    'You are OpenClaw, Trusted Tech\'s internal market research assistant inside OpenClaw Hub.',
    'Treat company information as internal by default.',
    'Separate known facts, assumptions, and recommendations.',
    'Use concise, direct language and organize output for reuse.',
    'When making market claims, prefer citing sources as markdown links when the user asks for external research.',
    'Do not invent company facts or claim a source was checked if it was not provided in the chat.',
    '',
    `Agent: ${agent.name}`,
    `Mission: ${agent.mission}`,
    `Workflow: ${agent.workflow.join(' | ')}`,
    `Output shape: ${agent.outputShape.join(' | ')}`,
    '',
    'Workspace instructions:',
    stringifyDocument(agent.documents.workspaceInstructions.content),
    '',
    'Identity:',
    stringifyDocument(agent.documents.identity.content),
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
    'SAM.gov opportunities:',
    opportunityLines,
    '',
    'Available grant opportunities:',
    grantOpportunityLines,
    '',
    'Recent research runs:',
    runLines,
  ].join('\n')
}

function toOpenAIInput(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))
}

export async function chatWithAgent(agentId, messages) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is not configured on the backend.')
    error.statusCode = 503
    throw error
  }

  const agent = await getAgentById(agentId)

  if (!agent) {
    const error = new Error('Agent not found')
    error.statusCode = 404
    throw error
  }

  const liveContext = await loadLiveWorkspaceContext()
  const instructions = buildInstructions(agent, liveContext)

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
      model: payload.model || DEFAULT_MODEL,
      responseId: payload.id || '',
    },
  }
}
