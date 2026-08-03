export async function fetchJson(url, options = {}) {
  const timeoutMs = Number(process.env.SEO_REQUEST_TIMEOUT_MS || 30000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) throw Object.assign(new Error(`SEO provider request failed (${response.status}).`), { statusCode: 502 })
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('SEO provider request timed out.'), { statusCode: 504 })
    throw error
  } finally {
    clearTimeout(timer)
  }
}
