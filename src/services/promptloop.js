/**
 * PromptLoop's REST API: run one of the team's saved research tasks on one
 * row and wait for the answer.
 *
 * PROMPTLOOP_API_KEY - the team's API key (PromptLoop settings). Without it
 * every call fails with a message that says so, rather than a bare 403.
 *
 * A single job has PromptLoop's own one-minute ceiling, so the timeout here
 * sits just above it.
 */
const BASE = 'https://api.promptloop.com'
const TIMEOUT_MS = 75 * 1000

export const promptloopConfigured = () => Boolean(process.env.PROMPTLOOP_API_KEY?.trim())

export async function runPromptloopTask(taskId, inputs, { version = 0 } = {}) {
  const key = process.env.PROMPTLOOP_API_KEY?.trim()
  if (!key) throw Object.assign(new Error('PromptLoop is not set up on the server (PROMPTLOOP_API_KEY).'), { statusCode: 503 })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${BASE}/v0.1/tasks/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: inputs.map((value) => String(value ?? '')), task_version: version }),
      signal: controller.signal,
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.status === 'error') {
      const detail = body.error?.message || body.message || `HTTP ${response.status}`
      throw Object.assign(new Error(`PromptLoop: ${detail}`), { statusCode: 502 })
    }
    const data = body.data || {}
    if (data.error_detected) throw Object.assign(new Error('PromptLoop could not complete the research.'), { statusCode: 502 })
    return data.data_json || data.list_data_json?.[0] || {}
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('PromptLoop took over a minute and was given up on.'), { statusCode: 504 })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
