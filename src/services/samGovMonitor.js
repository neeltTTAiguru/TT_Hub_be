import Opportunity from '../models/Opportunity.js'
import ResearchRun from '../models/ResearchRun.js'
import mongoose from 'mongoose'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const SAM_GOV_API_URL = 'https://api.sam.gov/opportunities/v2/search'
const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_KEYWORDS = [
  'body worn camera',
  'body-worn camera',
  'body camera',
  'evidence management',
  'digital evidence',
]

function getSamGovApiKey() {
  return String(process.env.SAM_GOV_API_KEY || '').trim()
}

function getDefaultModel() {
  return process.env.OPENAI_MODEL || 'gpt-4.1-mini'
}

function isMongoConnected() {
  return mongoose.connection.readyState === 1
}

function getDefaultSnapshotUrl() {
  return new URL('../../data/sam-gov-monitor.snapshot.json', import.meta.url)
}

async function readSnapshot(snapshotUrl) {
  try {
    const raw = await readFile(snapshotUrl, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.opportunities) ? parsed.opportunities : []
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function writeSnapshot(snapshotUrl, opportunities) {
  await mkdir(new URL('.', snapshotUrl), { recursive: true })
  await writeFile(
    snapshotUrl,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        opportunities,
      },
      null,
      2,
    ),
    'utf8',
  )
}

function diffOpportunities(previous, next) {
  const previousMap = new Map(previous.map((item) => [String(item.noticeId || ''), item]))
  const nextMap = new Map(next.map((item) => [String(item.noticeId || ''), item]))

  const added = []
  const removed = []
  const changed = []

  for (const [noticeId, item] of nextMap.entries()) {
    if (!noticeId) continue
    const prev = previousMap.get(noticeId)
    if (!prev) {
      added.push(noticeId)
      continue
    }

    const fields = ['title', 'agency', 'postedDate', 'responseDeadline', 'noticeType', 'setAside', 'active']
    const hasMaterialChange = fields.some((field) => String(prev?.[field] || '') !== String(item?.[field] || ''))
    if (hasMaterialChange) {
      changed.push(noticeId)
    }
  }

  for (const [noticeId] of previousMap.entries()) {
    if (!noticeId) continue
    if (!nextMap.has(noticeId)) {
      removed.push(noticeId)
    }
  }

  return {
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    added,
    removed,
    changed,
  }
}

function formatSamGovDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(value)
}

function getPostedDateRange(daysBack = 14) {
  const end = new Date()
  const start = new Date()
  start.setDate(end.getDate() - daysBack)

  return {
    postedFrom: formatSamGovDate(start),
    postedTo: formatSamGovDate(end),
  }
}

function normalizeOpportunity(item, keyword) {
  return {
    noticeId: String(item.noticeId || ''),
    title: String(item.title || 'Untitled opportunity'),
    solicitationNumber: String(item.solicitationNumber || '').trim(),
    agency: String(item.fullParentPathName || item.department || item.subTier || ''),
    office: String(item.office || ''),
    postedDate: String(item.postedDate || ''),
    responseDeadline: String(item.responseDeadLine || ''),
    noticeType: String(item.type || item.baseType || ''),
    setAside: String(item.typeOfSetAsideDescription || item.typeOfSetAside || ''),
    naicsCode: String(item.naicsCode || ''),
    classificationCode: String(item.classificationCode || ''),
    uiLink: String(item.uiLink || ''),
    descriptionLink: String(item.description || ''),
    sourceKeyword: keyword,
    active: String(item.active || 'Yes'),
  }
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

async function fetchKeywordOpportunities(keyword, limit = 10, daysBack = 14) {
  const samGovApiKey = getSamGovApiKey()

  if (!samGovApiKey) {
    const error = new Error('SAM_GOV_API_KEY is not configured on the backend.')
    error.statusCode = 503
    throw error
  }

  const { postedFrom, postedTo } = getPostedDateRange(daysBack)
  const query = new URLSearchParams({
    api_key: samGovApiKey,
    postedFrom,
    postedTo,
    title: keyword,
    limit: String(limit),
    offset: '0',
  })

  let response
  try {
    response = await fetch(`${SAM_GOV_API_URL}?${query.toString()}`)
  } catch (error) {
    const mapped = new Error(
      error?.cause?.code === 'ENOTFOUND'
        ? 'SAM.gov request failed (DNS lookup failed). This execution environment likely has outbound DNS/HTTPS blocked.'
        : 'SAM.gov request failed (network error).',
    )
    mapped.statusCode = 503
    mapped.cause = error
    throw mapped
  }

  if (!response.ok) {
    const body = await response.text()
    const error = new Error(body || `SAM.gov request failed with ${response.status}`)
    error.statusCode = response.status
    throw error
  }

  const payload = await response.json()
  const opportunities = Array.isArray(payload?.opportunitiesData) ? payload.opportunitiesData : []
  return opportunities.map((item) => normalizeOpportunity(item, keyword)).filter((item) => item.noticeId)
}

async function summarizeOpportunities(opportunities) {
  const fallback = () => ({
    summary: `Found ${opportunities.length} body-worn camera related SAM.gov opportunities in the current scan.`,
    findings: opportunities.slice(0, 3).map((opportunity) => ({
      summary: `${opportunity.title} (${opportunity.noticeType || 'Notice'})`,
      implication: `${opportunity.agency || 'Agency not listed'} posted this opportunity. Review fit and timeline.`,
      confidence: 'medium',
    })),
    recommendedNextSteps: [
      'Review the newest notices for alignment with Trusted Tech capabilities.',
      'Track agency and set-aside patterns across future scans.',
    ],
  })

  if (!process.env.OPENAI_API_KEY) {
    return fallback()
  }

  const compactInput = opportunities
    .slice(0, 10)
    .map(
      (opportunity) =>
        `- ${opportunity.title} | Agency: ${opportunity.agency || 'Unknown'} | Posted: ${opportunity.postedDate || 'Unknown'} | Deadline: ${
          opportunity.responseDeadline || 'Unknown'
        } | Type: ${opportunity.noticeType || 'Unknown'} | Set-aside: ${opportunity.setAside || 'None listed'} | Link: ${
          opportunity.uiLink || 'None'
        }`,
    )
    .join('\n')

  let response
  try {
    response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: getDefaultModel(),
        text: {
          format: {
            type: 'json_schema',
            name: 'sam_gov_monitor_report',
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['summary', 'findings', 'recommendedNextSteps'],
              properties: {
                summary: { type: 'string' },
                findings: {
                  type: 'array',
                  maxItems: 3,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['summary', 'implication', 'confidence'],
                    properties: {
                      summary: { type: 'string' },
                      implication: { type: 'string' },
                      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
                    },
                  },
                },
                recommendedNextSteps: {
                  type: 'array',
                  maxItems: 3,
                  items: { type: 'string' },
                },
              },
            },
          },
        },
        input: [
          {
            role: 'system',
            content:
              'You generate concise SAM.gov monitoring updates for Trusted Tech. Use only the provided opportunity data. Focus on signal, relevance, and what changed.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: [
                  'Summarize this body-worn camera related SAM.gov scan.',
                  'Call out the most relevant opportunities, agency patterns, and practical next steps for Trusted Tech.',
                  compactInput || 'No opportunities found.',
                ].join('\n\n'),
              },
            ],
          },
        ],
      }),
    })
  } catch (error) {
    return fallback()
  }

  if (!response.ok) {
    return fallback()
  }

  let parsed
  try {
    const payload = await response.json()
    const content = getTextFromResponse(payload)
    parsed = JSON.parse(content)
  } catch {
    return fallback()
  }

  return {
    summary: String(parsed.summary || ''),
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    recommendedNextSteps: Array.isArray(parsed.recommendedNextSteps) ? parsed.recommendedNextSteps : [],
  }
}

export async function runSamGovMonitor({
  keywords = DEFAULT_KEYWORDS,
  limitPerKeyword = 10,
  daysBack = 14,
  snapshotUrl = getDefaultSnapshotUrl(),
} = {}) {
  const keywordResults = await Promise.all(
    keywords.map((keyword) => fetchKeywordOpportunities(keyword, limitPerKeyword, daysBack)),
  )

  const deduped = Array.from(
    new Map(keywordResults.flat().map((opportunity) => [opportunity.noticeId, opportunity])).values(),
  ).sort((left, right) => String(right.postedDate).localeCompare(String(left.postedDate)))

  if (!isMongoConnected()) {
    const previous = await readSnapshot(snapshotUrl)
    const diff = diffOpportunities(previous, deduped)
    await writeSnapshot(snapshotUrl, deduped)
    const report = await summarizeOpportunities(deduped)

    return {
      opportunities: deduped,
      researchRun: null,
      report,
      diff,
    }
  }

  const savedOpportunities = await Promise.all(
    deduped.map((opportunity) =>
      Opportunity.findOneAndUpdate({ noticeId: opportunity.noticeId }, opportunity, {
        upsert: true,
        new: true,
        runValidators: true,
      }),
    ),
  )

  const report = await summarizeOpportunities(savedOpportunities)

  const run = await ResearchRun.create({
    title: `SAM.gov monitor: body-worn camera update`,
    objective: `Monitor SAM.gov for body-worn camera related opportunities and trend signals.`,
    scope: `Keywords: ${keywords.join(', ')}`,
    status: 'completed',
    requestedBy: 'sam-gov-monitor',
    findings: report.findings.map((finding, index) => ({
      summary: String(finding.summary || `Opportunity signal ${index + 1}`),
      implication: String(finding.implication || ''),
      confidence: ['low', 'medium', 'high'].includes(finding.confidence) ? finding.confidence : 'medium',
      sources: savedOpportunities.slice(0, 3).map((opportunity) => ({
        label: opportunity.title,
        url: opportunity.uiLink || opportunity.descriptionLink,
        sourceType: 'sam-gov',
      })),
    })),
    recommendedNextSteps: report.recommendedNextSteps,
    reportSummary: report.summary,
  })

  return {
    opportunities: savedOpportunities,
    researchRun: run,
  }
}
