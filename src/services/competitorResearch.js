// Competitor "mini hub" website research. Given a tracked competitor, this uses
// the OpenAI Responses API with the built-in `web_search` tool to actively find
// and read THAT specific company's body-worn / in-car camera product & spec
// pages (preferring their own domain), then extracts their BWC models and specs
// as structured data with a cited source URL per model. Results can then be
// saved into that competitor's brain section.
//
// This replaces an earlier approach that blindly fetched the homepage and three
// regex-discovered links — which locked onto nav/marketing junk on any real
// site and almost never reached the actual body-worn-camera model pages.

import { getCompetitorBySlug } from '../data/publicSafetyCompetitors.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
// web_search only runs on models that support the built-in tool. Allow an
// override, but default to the account's configured model (gpt-4.1-mini et al).
const DEFAULT_MODEL = process.env.COMPETITOR_RESEARCH_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini'
// web_search + multi-page reads take longer than a plain fetch; give it room.
const REQUEST_TIMEOUT_MS = Number(process.env.COMPETITOR_RESEARCH_TIMEOUT_MS || 90000)

// The spec fields we capture per BWC model. Keep in sync with the manual-capture
// form (feCRM/src/pages/CompetitorAnalyst.tsx SPEC_FIELDS) so auto-collected
// sections are as complete as hand-entered ones.
const MODEL_PROPERTIES = {
  name: { type: 'string', description: 'Product / model name, e.g. "Axon Body 4".' },
  category: { type: 'string', description: 'One of: body-worn, in-car, other.' },
  batteryLife: { type: 'string', description: 'Recording hours; whether swappable.' },
  resolution: { type: 'string', description: 'Video resolution and frame rate.' },
  storage: { type: 'string', description: 'Onboard storage capacity.' },
  fieldOfView: { type: 'string', description: 'Field of view in degrees.' },
  preRecord: { type: 'string', description: 'Pre-record / buffer duration.' },
  durability: { type: 'string', description: 'IP rating, MIL-STD, ruggedization.' },
  weight: { type: 'string', description: 'Weight / form factor.' },
  lowLight: { type: 'string', description: 'Low-light / night / IR performance.' },
  connectivity: { type: 'string', description: 'Wi-Fi / LTE / Bluetooth / GPS.' },
  activation: { type: 'string', description: 'Manual, holster, gunshot, auto, etc.' },
  evidenceManagement: { type: 'string', description: 'DEMS / evidence platform it works with.' },
  price: { type: 'string', description: 'Price or licensing model, if stated.' },
  notes: { type: 'string', description: 'Positioning / differentiators worth retaining.' },
  source: { type: 'string', description: 'URL this model\'s specs were read from (prefer official).' },
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'models'],
  properties: {
    overview: { type: 'string', description: "1-3 sentences on this company's BWC/in-car portfolio." },
    models: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(MODEL_PROPERTIES),
        properties: MODEL_PROPERTIES,
      },
    },
  },
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

// Models sometimes emit "Not specified" / "N/A" / "Unknown" instead of the empty
// string we ask for. Treat those as unknown so they don't get saved as real specs.
const UNKNOWN_VALUE = /^(n\/?a|na|none|null|unknown|not\s+(specified|stated|listed|available|provided|disclosed|found)|not\s+applicable|tbd|-{1,}|—)$/i
// "Contact us for pricing" style non-answers — real text on the page, but not a spec.
const NON_SPEC_PRICE = /(contact\b.*\b(pric|sales|quote|us)|request\b.*\bquote|call\b.*\bpric|available\s+upon\s+request|inquire)/i

function cleanSpec(value) {
  const trimmed = String(value || '').trim()
  return UNKNOWN_VALUE.test(trimmed) ? '' : trimmed
}

function normalizeModel(model) {
  const cleaned = {}
  for (const key of Object.keys(MODEL_PROPERTIES)) {
    cleaned[key] = key === 'source' ? String(model?.[key] || '').trim() : cleanSpec(model?.[key])
  }
  cleaned.name = String(model?.name || '').trim()
  if (NON_SPEC_PRICE.test(cleaned.price)) cleaned.price = ''
  return cleaned
}

// Concatenate every output_text chunk in a Responses payload.
function getTextFromResponse(payload) {
  if (!Array.isArray(payload?.output)) return ''
  return payload.output
    .flatMap((item) =>
      item?.type === 'message' && Array.isArray(item.content)
        ? item.content
            .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
            .map((content) => content.text)
        : [],
    )
    .join('\n')
    .trim()
}

// Pull the URLs the model actually cited (url_citation annotations) so the UI
// can show which pages were read. Falls back to per-model `source` URLs.
function getCitedUrls(payload, models) {
  const urls = new Set()
  if (Array.isArray(payload?.output)) {
    for (const item of payload.output) {
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue
      for (const content of item.content) {
        for (const annotation of content?.annotations || []) {
          if (annotation?.type === 'url_citation' && annotation.url) {
            urls.add(String(annotation.url).split('#')[0])
          }
        }
      }
    }
  }
  for (const model of models || []) {
    if (model?.source) urls.add(String(model.source).split('#')[0])
  }
  return [...urls]
}

async function callOpenAI(body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text()
      throw Object.assign(new Error(text || `OpenAI request failed with ${response.status}`), {
        statusCode: response.status,
      })
    }
    return response.json()
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Competitor research timed out while searching the web.'), { statusCode: 504 })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function researchCompetitorWebsite(competitorSlug) {
  const competitor = getCompetitorBySlug(competitorSlug)
  if (!competitor) {
    throw Object.assign(new Error('Unknown competitor.'), { statusCode: 400 })
  }
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('OPENAI_API_KEY is not configured on the backend.'), { statusCode: 503 })
  }

  const domain = domainOf(competitor.website)

  const payload = await callOpenAI({
    model: DEFAULT_MODEL,
    tools: [{ type: 'web_search' }],
    tool_choice: 'auto',
    // Cap tool iterations so a run can't loop indefinitely on a hard-to-scrape site.
    max_tool_calls: Number(process.env.COMPETITOR_RESEARCH_MAX_TOOL_CALLS || 12),
    text: {
      format: {
        type: 'json_schema',
        name: 'competitor_bwc_models',
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
    input: [
      {
        role: 'system',
        content: [
          'You are a competitive-intelligence researcher for a public-safety body-worn camera (BWC) company.',
          'Work in two stages. STAGE 1: use web_search to identify the competitor\'s CURRENT body-worn and in-car video camera product lines/models.',
          `STAGE 2: for EACH model, run a focused search for that model\'s official product or specifications page (e.g. "<model name> specifications ${domain}"), open it, and read the spec table.`,
          `Strongly prefer pages on the company\'s official domain (${domain}); use reputable datasheets/spec sheets only to fill gaps. Do not rely on press releases or news articles for specs.`,
          'Extract the specs that matter for public-safety procurement: battery life, resolution/frame rate, storage, field of view, pre-record buffer, durability (IP/MIL-STD), weight, low-light, connectivity, activation, evidence/DEMS platform, and price/licensing.',
          'Rules: use ONLY values you actually read on a source page. Never invent or guess models or specs. If a spec is genuinely not stated on any page you read, return an EMPTY STRING for it — never write "Not specified", "N/A", or "Unknown".',
          'Only include real body-worn or in-car camera products sold to public safety / law enforcement. Exclude accessories, docks, mounts, software-only products, and unrelated hardware.',
          'For every model, set `source` to the exact URL of the official product/specifications page you read its specs from.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Competitor: ${competitor.name}`,
          `Official website: ${competitor.website}`,
          'Research their body-worn and in-car camera lineup. Return an overview of the portfolio and a list of models with any specs you can source.',
        ].join('\n'),
      },
    ],
  })

  let parsed
  try {
    parsed = JSON.parse(getTextFromResponse(payload))
  } catch {
    parsed = null
  }

  const models = Array.isArray(parsed?.models)
    ? parsed.models
        .filter((model) => String(model?.name || '').trim())
        .map(normalizeModel)
        .slice(0, 12)
    : []
  const pagesRead = getCitedUrls(payload, models)

  return {
    competitor: competitor.slug,
    competitorName: competitor.name,
    website: competitor.website,
    pagesRead,
    overview: String(parsed?.overview || '').trim(),
    models,
  }
}
