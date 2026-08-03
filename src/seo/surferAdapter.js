import { fetchJson } from './http.js'
import { mockSurfer } from './fixtures.js'
import { normalizeSurfer } from './normalizers.js'

export async function getSurferRecommendations(input, article) {
  if (input.manual_surfer_recommendations) return normalizeSurfer(input.manual_surfer_recommendations)
  if (process.env.SEO_USE_MOCK_SURFER === 'true') return normalizeSurfer(mockSurfer)
  if (!process.env.SURFER_API_KEY || !process.env.SURFER_API_URL) {
    throw Object.assign(new Error('SURFER_API_KEY and SURFER_API_URL are required unless mock or manual recommendations are used.'), { statusCode: 503 })
  }
  const raw = await fetchJson(process.env.SURFER_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SURFER_API_KEY}` },
    body: JSON.stringify({ keyword: input.primary_keyword, content: article.slice(0, 50000) }),
  })
  return normalizeSurfer(raw)
}
