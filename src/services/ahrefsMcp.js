// Ahrefs runs as an MCP server INSIDE the Hermes container. The only honest way to
// know it actually works is to run a real Ahrefs tool call THROUGH Hermes and see if
// data comes back — that exercises the whole path (Hermes -> its tool filter -> Ahrefs).
//
// Why not simpler checks:
//   - a static env flag (AHREFS_MCP_ENABLED) lies the moment Ahrefs breaks.
//   - a direct MCP `initialize` handshake only proves the endpoint is reachable; it
//     would NOT catch a broken Hermes tool filter, an expired key at Hermes, quota
//     exhaustion, or Hermes itself being down.
// This probe catches all of those: if the call can't return Ahrefs data, the badge
// goes red on its own within one cache window.

import { chatWithHermes } from './hermesChat.js'

const OK_TTL_MS = Number(process.env.AHREFS_HEALTH_OK_TTL_MS || 5 * 60 * 1000)
const FAIL_TTL_MS = Number(process.env.AHREFS_HEALTH_FAIL_TTL_MS || 90 * 1000)
// A real tool-calling turn through Hermes takes ~30s, so give it margin.
const PROBE_TIMEOUT_MS = Number(process.env.AHREFS_HEALTH_TIMEOUT_MS || 45000)

const PROBE_INSTRUCTIONS = `You are an automated health probe. Make EXACTLY ONE tool call, then stop.
Call the tool keywords_explorer_overview with EXACTLY these arguments, unchanged:
  country = "us"
  keywords = "body worn camera"
  select = "keyword,volume_monthly,cpc"
Do NOT add, remove, or modify any argument. Do NOT call any other tool. Do NOT retry.
Then reply with ONE line and nothing else:
- If the tool call returned data rows, reply exactly: AHREFS_OK
- If keywords_explorer_overview is not available, or the call errored, reply exactly: AHREFS_FAIL: <short reason>`

let cached = null // { status: 'connected' | 'not_configured', ts: number, reason?: string }
let inflight = null

async function probeThroughHermes() {
  const response = await chatWithHermes(
    'content-operations-assistant',
    [{ role: 'user', content: 'Run the Ahrefs health probe now.' }],
    { instructions: PROBE_INSTRUCTIONS, memoryContext: '', timeoutMs: PROBE_TIMEOUT_MS, rateLimitRetries: 1 },
  )
  const text = String(response?.message?.content || '')
  // AHREFS_OK wins: a real data call succeeded even if the model narrated an earlier
  // retry/param error. Only red when there is no success signal at all.
  if (/AHREFS_OK/.test(text)) return { status: 'connected' }
  const reason = (text.match(/AHREFS_FAIL:\s*(.*)/)?.[1] || text || 'probe returned no success signal').slice(0, 300)
  return { status: 'not_configured', reason }
}

function refresh() {
  if (inflight) return inflight
  inflight = probeThroughHermes()
    .then((result) => {
      cached = { ...result, ts: Date.now() }
      if (result.status !== 'connected') console.warn('[ahrefs-health] probe not healthy:', result.reason)
      return cached.status
    })
    .catch((error) => {
      // Hermes unreachable / unconfigured / timeout -> we cannot verify, so report red.
      cached = { status: 'not_configured', ts: Date.now(), reason: error?.message?.slice(0, 300) }
      console.warn('[ahrefs-health] probe error:', error?.message)
      return cached.status
    })
    .finally(() => { inflight = null })
  return inflight
}

// On-demand, non-blocking, fail-closed. A real probe takes ~30s so we never block a
// page load on it. We serve the last VERIFIED status instantly and re-verify in the
// background once it goes stale. Until the first probe resolves we report 'not_configured'
// (fail-closed) — the badge is only ever green when a real Ahrefs call actually succeeded,
// and it flips itself red within one refresh cycle whenever Ahrefs/Hermes breaks.
export async function getAhrefsMcpStatus() {
  if (!cached) { refresh(); return 'not_configured' }
  const ttl = cached.status === 'connected' ? OK_TTL_MS : FAIL_TTL_MS
  if (Date.now() - cached.ts > ttl && !inflight) refresh() // fire-and-forget revalidate
  return cached.status
}
