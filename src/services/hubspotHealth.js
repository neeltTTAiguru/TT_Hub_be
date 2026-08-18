// Liveness monitor for the HubSpot MCP tools inside the Hermes gateway.
//
// Why this exists: the gateway loads each MCP server at startup and SILENTLY
// drops any that fails to connect. HubSpot is the only OAuth MCP, so it is the
// only one that can vanish this way (2026-08-03 a missing token file; 2026-08-17
// a second gateway racing it for OAuth redirect port 8765). Nothing surfaces the
// drop: `hermes mcp list` still reports hubspot "enabled", /health still returns
// ok, and the model keeps answering — from whatever stale deal facts happen to
// be in the conversation. That is the dangerous part: on 2026-08-17 the agent
// reported a deal as "Quote Sent" for five days after it had gone Closed Won.
//
// So we probe for the tools directly and fail CLOSED: if the gateway has no
// HubSpot tools, the deal assistant refuses to answer instead of guessing.
// The probe runs on a background interval, so requests read a cached verdict
// and pay no latency.

const PROBE_INSTRUCTIONS = `You are a connectivity probe, not an assistant.
Call the tool mcp__hubspot__get_user_details exactly once and reply with ONLY the numeric hub id.
If you have no callable tool whose name starts with mcp__hubspot__, or the call fails, reply with exactly HUBSPOT_TOOLS_UNAVAILABLE.
Output nothing else — no explanation, no punctuation, no apology.`

export const HUBSPOT_UNAVAILABLE_SENTINEL = 'HUBSPOT_TOOLS_UNAVAILABLE'

// Shown to the user when we know the tools are gone. Deliberately says what is
// broken and what to do, because the alternative (a confident stale answer) is
// worse than an error.
export const HUBSPOT_UNAVAILABLE_MESSAGE =
  'The HubSpot connection is down, so I cannot verify any deal data right now. '
  + 'Nothing below this point would be live CRM data, so I am not answering from memory. '
  + 'The Hermes gateway has lost its HubSpot tools and needs to be restarted.'

const PROBE_TIMEOUT_MS = Number(process.env.HUBSPOT_HEALTH_PROBE_TIMEOUT_MS || 60000)
const INTERVAL_MS = Number(process.env.HUBSPOT_HEALTH_INTERVAL_MS || 10 * 60 * 1000)
const INITIAL_DELAY_MS = Number(process.env.HUBSPOT_HEALTH_INITIAL_DELAY_MS || 15000)

// 'unknown' is deliberately NOT treated as down. A probe that times out or hits
// a 502 tells us nothing about the tools, and blocking the assistant on an
// inconclusive probe would trade a rare silent-stale bug for a common outage.
// Only a gateway that answered and proved it has no HubSpot tools is 'down'.
let state = { status: 'unknown', hubId: '', checkedAt: null, error: '' }

export function getHubSpotHealth() {
  return { ...state }
}

// Exported for tests and for the manual `npm run hubspot:check` script.
export function classifyProbeContent(content) {
  const text = String(content || '').trim()
  if (!text) return { status: 'unknown', hubId: '', error: 'Probe returned an empty response.' }
  if (text.includes(HUBSPOT_UNAVAILABLE_SENTINEL)) {
    return { status: 'down', hubId: '', error: 'Gateway reported no callable mcp__hubspot__* tools.' }
  }
  const hubId = (text.match(/\b\d{6,12}\b/) || [])[0] || ''
  if (hubId) return { status: 'ok', hubId, error: '' }
  // The model answered but neither called the tool nor used the sentinel. That
  // is not proof of a drop, so stay 'unknown' rather than block the assistant.
  return { status: 'unknown', hubId: '', error: `Unrecognized probe reply: ${text.slice(0, 120)}` }
}

export async function probeHubSpotTools() {
  const baseUrl = String(process.env.HERMES_API_URL || '').replace(/\/$/, '')
  const apiKey = String(process.env.HERMES_API_KEY || '')
  if (!baseUrl || !apiKey) {
    return { status: 'unknown', hubId: '', error: 'Hermes is not configured on the backend.' }
  }

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.HERMES_MODEL || 'hermes-agent',
        messages: [
          { role: 'system', content: PROBE_INSTRUCTIONS },
          { role: 'user', content: 'probe' },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { status: 'unknown', hubId: '', error: `Gateway probe failed with ${response.status}.` }
    }
    const payload = await response.json()
    return classifyProbeContent(payload?.choices?.[0]?.message?.content)
  } catch (error) {
    return { status: 'unknown', hubId: '', error: error?.message || 'Gateway probe failed.' }
  }
}

export async function refreshHubSpotHealth() {
  const previous = state.status
  const result = await probeHubSpotTools()
  state = { ...result, checkedAt: new Date().toISOString() }

  // Log every transition loudly. Five silent days is what made the last outage
  // expensive; a line in the server log is the cheapest possible tripwire.
  if (result.status !== previous) {
    if (result.status === 'ok') {
      console.log(`[hubspot-health] tools OK (hub ${result.hubId})`)
    } else if (result.status === 'down') {
      console.error(`[hubspot-health] DOWN — the Hermes gateway has no mcp__hubspot__* tools. ${result.error}`)
    } else {
      console.warn(`[hubspot-health] indeterminate — ${result.error}`)
    }
  }
  return getHubSpotHealth()
}

export function startHubSpotHealthMonitor() {
  if (String(process.env.HUBSPOT_HEALTH_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('HubSpot health monitor disabled (HUBSPOT_HEALTH_ENABLED=false).')
    return
  }
  console.log(`HubSpot health monitor: every ${Math.round(INTERVAL_MS / 60000)}m (first probe in ${Math.round(INITIAL_DELAY_MS / 1000)}s).`)

  const first = setTimeout(() => {
    refreshHubSpotHealth().catch((error) => console.error('[hubspot-health] probe threw', error))
  }, INITIAL_DELAY_MS)
  first.unref?.()

  const timer = setInterval(() => {
    refreshHubSpotHealth().catch((error) => console.error('[hubspot-health] probe threw', error))
  }, INTERVAL_MS)
  timer.unref?.()
}

// Call before serving any HubSpot deal question. Throws only on a CONFIRMED
// drop, so an inconclusive probe never blocks a working assistant.
export function assertHubSpotToolsAvailable() {
  if (state.status !== 'down') return
  const error = new Error(HUBSPOT_UNAVAILABLE_MESSAGE)
  error.statusCode = 503
  error.code = 'HUBSPOT_TOOLS_UNAVAILABLE'
  throw error
}

// Streaming guard. The agent answers the unavailable sentinel as its ENTIRE
// reply, so hold the opening tokens back until enough have arrived to rule the
// sentinel out — otherwise it flashes into the chat bubble before the error
// lands. Anything shorter than the sentinel is released by flush() at stream end.
export function createSentinelGate(write) {
  let held = ''
  let released = false
  return {
    emit(delta) {
      if (released) return write(delta)
      held += delta
      if (held.includes(HUBSPOT_UNAVAILABLE_SENTINEL)) return
      if (held.length <= HUBSPOT_UNAVAILABLE_SENTINEL.length) return
      released = true
      const pending = held
      held = ''
      return write(pending)
    },
    flush() {
      if (released || !held) return
      released = true
      const pending = held
      held = ''
      write(pending)
    },
  }
}

// Second line of defense, for a drop that happens between probes: the agent is
// instructed to emit the sentinel when it has no tools, and we turn that into a
// hard error rather than letting it reach the user as chat text.
export function assertResponseIsLive(content) {
  if (!String(content || '').includes(HUBSPOT_UNAVAILABLE_SENTINEL)) return
  state = { status: 'down', hubId: '', checkedAt: new Date().toISOString(), error: 'Agent reported no HubSpot tools mid-conversation.' }
  console.error('[hubspot-health] DOWN — agent emitted the unavailable sentinel mid-conversation.')
  const error = new Error(HUBSPOT_UNAVAILABLE_MESSAGE)
  error.statusCode = 503
  error.code = 'HUBSPOT_TOOLS_UNAVAILABLE'
  throw error
}
