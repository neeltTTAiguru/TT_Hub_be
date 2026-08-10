// Ahrefs is not configured in beCRM itself — it runs as an MCP server inside the
// Hermes container (config.yaml -> mcp.ahrefs, enabled + Bearer ${MCP_AHREFS_API_KEY}).
// The Content Generator badge must reflect that container reality, but the Hermes
// gateway exposes no tool/MCP introspection endpoint (only /v1/models and
// /v1/chat/completions). So instead of reading a disconnected local flag, we do a
// live MCP `initialize` handshake against the exact same Ahrefs endpoint + key
// Hermes uses. If that answers, Ahrefs is genuinely reachable and the badge is honest.

const DEFAULT_AHREFS_MCP_URL = 'https://api.ahrefs.com/mcp/mcp'
const REQUEST_TIMEOUT_MS = Number(process.env.AHREFS_MCP_TIMEOUT_MS || 6000)
const OK_TTL_MS = Number(process.env.AHREFS_MCP_STATUS_TTL_MS || 5 * 60 * 1000)
const FAIL_TTL_MS = Number(process.env.AHREFS_MCP_FAIL_TTL_MS || 60 * 1000)

let cached = null // { status: 'connected' | 'not_configured', expiresAt: number }

function ahrefsMcpConfiguration() {
  const url = String(process.env.AHREFS_MCP_URL || DEFAULT_AHREFS_MCP_URL).trim()
  const apiKey = String(process.env.MCP_AHREFS_API_KEY || '').trim()
  return { url, apiKey }
}

// True only when the env carries the pieces needed to even attempt a call.
export function isAhrefsMcpConfigured() {
  const { url, apiKey } = ahrefsMcpConfiguration()
  return Boolean(url && apiKey)
}

async function probeAhrefsMcp() {
  const { url, apiKey } = ahrefsMcpConfiguration()
  if (!url || !apiKey) return 'not_configured'

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'becrm-healthcheck', version: '1.0' },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) return 'not_configured'
    // The server may answer as JSON or as an SSE frame; both carry the handshake result.
    const body = await response.text().catch(() => '')
    return /"serverInfo"|"protocolVersion"/.test(body) ? 'connected' : 'not_configured'
  } catch {
    return 'not_configured'
  } finally {
    clearTimeout(timeout)
  }
}

// Cached so a page-load hitting GET /content-operations/integrations doesn't
// handshake with Ahrefs every time. Failures cache for a shorter window so the
// badge recovers quickly once the integration comes back.
export async function getAhrefsMcpStatus() {
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.status
  const status = await probeAhrefsMcp()
  cached = { status, expiresAt: now + (status === 'connected' ? OK_TTL_MS : FAIL_TTL_MS) }
  return cached.status
}
