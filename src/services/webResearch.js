// General web research for Hermes, as the hub MCP tool `web_research`.
//
// Hermes' own web_search / web_extract are not dependable (ddgs backend), and
// the hub's chat agents (market-researcher etc.) answer from model knowledge
// without browsing. This is the same OpenAI Responses `web_search` path the
// competitor and agency-briefing research already use, so a mail-agent answer
// built on it has real, cited sources.

const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = process.env.WEB_RESEARCH_MODEL || 'gpt-5'
const REQUEST_TIMEOUT_MS = Number(process.env.WEB_RESEARCH_TIMEOUT_MS || 300000)
const MAX_TOOL_CALLS = Number(process.env.WEB_RESEARCH_MAX_TOOL_CALLS || 12)

function getTextFromResponse(payload) {
  if (!Array.isArray(payload?.output)) return ''
  return payload.output
    .flatMap((item) => {
      if (item?.type !== 'message' || !Array.isArray(item.content)) return []
      return item.content
        .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text)
    })
    .join('\n')
    .trim()
}

function getCitedUrls(payload) {
  const urls = new Set()
  if (!Array.isArray(payload?.output)) return []
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
  return [...urls]
}

export async function webResearch({ question, context = '' }) {
  const ask = String(question || '').trim()
  if (!ask) throw new Error('The question is empty.')
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured on the backend.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let payload
  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        max_tool_calls: MAX_TOOL_CALLS,
        input: [
          {
            role: 'system',
            content: [
              'You are a research analyst for Trusted Technology, a public-safety body-worn camera company.',
              'Search the web and read the relevant pages before answering. Use only facts you read on a page; never guess.',
              'Answer in plain text: the direct answer first, then the supporting detail. Cite the source URL for each fact.',
              'If the web does not answer the question, say so plainly instead of filling the gap.',
            ].join(' '),
          },
          { role: 'user', content: context ? `${ask}\n\nContext: ${String(context).trim()}` : ask },
        ],
      }),
    })
    if (!response.ok) throw new Error((await response.text()) || `OpenAI request failed with ${response.status}`)
    payload = await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Web research timed out.')
    throw error
  } finally {
    clearTimeout(timer)
  }

  return { answer: getTextFromResponse(payload), sources: getCitedUrls(payload) }
}
