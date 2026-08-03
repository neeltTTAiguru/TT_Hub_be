import { fetchJson } from './http.js'
import { mockAhrefs } from './fixtures.js'
import { normalizeAhrefs } from './normalizers.js'

export async function getAhrefsResearch(input) {
  if (input.manual_keyword_research) return normalizeAhrefs(input.manual_keyword_research, input.primary_keyword)
  if (process.env.SEO_USE_MOCK_AHREFS === 'true') return normalizeAhrefs(mockAhrefs, input.primary_keyword)
  if (!process.env.AHREFS_API_KEY) throw Object.assign(new Error('AHREFS_API_KEY is required unless mock or manual research is used.'), { statusCode: 503 })
  const base = String(process.env.AHREFS_API_URL || 'https://api.ahrefs.com/v3').replace(/\/$/, '')
  const url = new URL(`${base}/keywords-explorer/overview`)
  url.searchParams.set('keyword', input.primary_keyword)
  const raw = await fetchJson(url, { headers: { Authorization: `Bearer ${process.env.AHREFS_API_KEY}` } })
  console.info(JSON.stringify({ event: 'seo_provider_complete', provider: 'ahrefs', unavailable_fields_are_null: true }))
  return normalizeAhrefs(raw, input.primary_keyword)
}
