// Competitor "mini hub" website research: fetches a tracked competitor's own
// website (homepage + a couple of body-worn-camera / product subpages),
// extracts readable text server-side (no browser needed), and uses the OpenAI
// Responses API to pull out their BWC models and specs. Results can then be
// saved into that competitor's brain section.

import { getCompetitorBySlug } from '../data/publicSafetyCompetitors.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'
const FETCH_TIMEOUT_MS = Number(process.env.COMPETITOR_FETCH_TIMEOUT_MS || 12000)
const MAX_SUBPAGES = 3

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;|&#0*38;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTitle(html) {
  return (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchPage(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'TrustedTechHub/1.0 (+competitor-research)',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') || ''
    if (contentType && !/text\/html|xhtml|xml/i.test(contentType)) return null
    const html = (await response.text()).slice(0, 800000)
    return { url: response.url || url, html }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

// Find same-domain links that look like product / body-worn-camera pages.
function discoverProductLinks(html, baseUrl) {
  const baseDomain = domainOf(baseUrl)
  const relevant = /body.?worn|body.?cam|\bbwc\b|camera|product|hardware|solution|law.?enforcement|public.?safety|devices?/i
  const seen = new Set([baseUrl])
  const links = []
  for (const match of String(html).matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = htmlToText(match[3])
    let resolved
    try {
      resolved = new URL(match[2], baseUrl).href.split('#')[0]
    } catch {
      continue
    }
    if (seen.has(resolved)) continue
    if (domainOf(resolved) !== baseDomain) continue
    if (!relevant.test(`${label} ${resolved}`)) continue
    seen.add(resolved)
    links.push(resolved)
    if (links.length >= MAX_SUBPAGES) break
  }
  return links
}

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

async function extractModels(competitor, pageText, pagesRead) {
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      text: {
        format: {
          type: 'json_schema',
          name: 'competitor_bwc_models',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['overview', 'models'],
            properties: {
              overview: { type: 'string' },
              models: {
                type: 'array',
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'name',
                    'batteryLife',
                    'resolution',
                    'storage',
                    'weight',
                    'durability',
                    'connectivity',
                    'activation',
                    'notes',
                  ],
                  properties: {
                    name: { type: 'string' },
                    batteryLife: { type: 'string' },
                    resolution: { type: 'string' },
                    storage: { type: 'string' },
                    weight: { type: 'string' },
                    durability: { type: 'string' },
                    connectivity: { type: 'string' },
                    activation: { type: 'string' },
                    notes: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      input: [
        {
          role: 'system',
          content:
            'You extract body-worn camera (BWC) product models and specs for a competitor from their own website text. Use ONLY the provided text. Do not invent models or specs. If a spec is not stated, return an empty string for it. Only include actual body-worn / in-car camera product lines sold to public safety or law enforcement; ignore accessories, docks, and unrelated products.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `Competitor: ${competitor.name} (${competitor.website})`,
                `Pages read: ${pagesRead.join(', ')}`,
                'Website text:',
                pageText,
                'Return an overview of their BWC portfolio and a list of their body-worn camera models with any specs stated in the text.',
              ].join('\n\n'),
            },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    const error = new Error(body || `OpenAI request failed with ${response.status}`)
    error.statusCode = response.status
    throw error
  }

  const payload = await response.json()
  let parsed
  try {
    parsed = JSON.parse(getTextFromResponse(payload))
  } catch {
    parsed = null
  }
  const models = Array.isArray(parsed?.models)
    ? parsed.models.filter((model) => String(model?.name || '').trim()).slice(0, 12)
    : []
  return { overview: String(parsed?.overview || '').trim(), models }
}

export async function researchCompetitorWebsite(competitorSlug) {
  const competitor = getCompetitorBySlug(competitorSlug)
  if (!competitor) {
    throw Object.assign(new Error('Unknown competitor.'), { statusCode: 400 })
  }
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error('OPENAI_API_KEY is not configured on the backend.'), { statusCode: 503 })
  }

  const home = await fetchPage(competitor.website)
  if (!home) {
    throw Object.assign(
      new Error(`Could not load ${competitor.website}. The site may block automated reads.`),
      { statusCode: 502 },
    )
  }

  const homeText = htmlToText(home.html)
  const subPageUrls = discoverProductLinks(home.html, home.url)
  const subPages = (await Promise.all(subPageUrls.map((url) => fetchPage(url))))
    .filter(Boolean)
    .map((page) => ({ url: page.url, text: htmlToText(page.html) }))
    .filter((page) => page.text.length > 200)

  const pagesRead = [home.url, ...subPages.map((page) => page.url)]
  const combined = [
    `HOMEPAGE (${home.url}) title: ${extractTitle(home.html)}`,
    homeText.slice(0, 9000),
    ...subPages.map((page) => `PAGE (${page.url}):\n${page.text.slice(0, 5000)}`),
  ]
    .join('\n\n')
    .slice(0, 24000)

  const { overview, models } = await extractModels(competitor, combined, pagesRead)

  return {
    competitor: competitor.slug,
    competitorName: competitor.name,
    website: competitor.website,
    pagesRead,
    overview,
    models,
  }
}
