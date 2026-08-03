const REQUEST_TIMEOUT_MS = Number(process.env.HUBSPOT_MCP_REQUEST_TIMEOUT_MS || 25000)

const DEAL_COLUMNS = [
  'Deal Name', 'Deal Stage', 'Presentation/Demo Completed', 'Trial / Quote Requested',
  'Date Trial Agreement Sent', 'Trial Agreement Executed', 'Date Trial Started', 'Date Trial Ends',
  'Trial Outcome', 'Date Quote Sent', 'Date Purchase Order Received', 'Purchase Order Amount',
  'Date MSA Sent', 'MSA Executed?', 'Term of the MSA', 'Payment Cycle',
  'Number of Cameras Purchased', 'MSA Renewal Date', 'Redaction Amount', 'Term, Payment, Rate',
  'Close Date', 'Number of Calls', 'Number of Emails', 'Connected Over Call?',
  'Connected Over Email?', 'Qualified Lead?', 'Meeting Status', 'Handed Off To SAE?',
  'Deal Owner', 'SDR Deal Owner', 'Amount', 'Description',
]

let cachedAccessToken = ''
let cachedAccessTokenExpiresAt = 0

function configurationError(message) {
  return Object.assign(new Error(message), { statusCode: 503 })
}

function upstreamError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { statusCode: 502 })
}

function getConfig() {
  const url = String(process.env.HUBSPOT_MCP_URL || '').trim()
  const accessToken = String(process.env.HUBSPOT_MCP_ACCESS_TOKEN || '').trim()
  const refreshToken = String(process.env.HUBSPOT_MCP_REFRESH_TOKEN || '').trim()
  const clientId = String(process.env.HUBSPOT_MCP_CLIENT_ID || '').trim()
  const clientSecret = String(process.env.HUBSPOT_MCP_CLIENT_SECRET || '').trim()
  const tokenUrl = String(process.env.HUBSPOT_MCP_TOKEN_URL || '').trim()

  if (!url) throw configurationError('HUBSPOT_MCP_URL is not configured on the backend.')
  if (!accessToken && !(refreshToken && clientId && clientSecret && tokenUrl)) {
    throw configurationError('Configure HUBSPOT_MCP_ACCESS_TOKEN or the HubSpot MCP OAuth refresh credentials.')
  }

  return { url, accessToken, refreshToken, clientId, clientSecret, tokenUrl }
}

async function refreshAccessToken(config) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw upstreamError(`HubSpot MCP token refresh failed with ${response.status}.`)
  const payload = await response.json()
  if (!payload?.access_token) throw upstreamError('HubSpot MCP token refresh returned no access token.')
  cachedAccessToken = payload.access_token
  cachedAccessTokenExpiresAt = Date.now() + Math.max(30, Number(payload.expires_in || 1800) - 30) * 1000
  return cachedAccessToken
}

async function getAccessToken(config, forceRefresh = false) {
  if (!forceRefresh && cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) return cachedAccessToken
  if (!forceRefresh && config.accessToken) return config.accessToken
  if (config.refreshToken && config.clientId && config.clientSecret && config.tokenUrl) {
    return refreshAccessToken(config)
  }
  throw upstreamError('The HubSpot MCP access token was rejected and no refresh credentials are configured.')
}

function parseMcpPayload(raw, contentType) {
  if (contentType.includes('text/event-stream')) {
    const data = raw.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]')
      .at(-1)
    return data ? JSON.parse(data) : {}
  }
  return raw ? JSON.parse(raw) : {}
}

async function postMcp(config, token, body, sessionId = '') {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const raw = await response.text()
  if (!response.ok) {
    const error = upstreamError(`HubSpot MCP request failed with ${response.status}.`)
    error.upstreamStatus = response.status
    throw error
  }
  let payload
  try {
    payload = parseMcpPayload(raw, response.headers.get('content-type') || '')
  } catch (error) {
    throw upstreamError('HubSpot MCP returned an invalid response.', error)
  }
  if (payload?.error) throw upstreamError(payload.error.message || 'HubSpot MCP tool call failed.')
  return { payload, sessionId: response.headers.get('mcp-session-id') || sessionId }
}

async function connect(config, token) {
  const initialized = await postMcp(config, token, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'trusted-tech-deals', version: '1.0' },
    },
  })
  if (!initialized.sessionId) throw upstreamError('HubSpot MCP did not establish a session.')
  await postMcp(config, token, {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {},
  }, initialized.sessionId)
  return initialized.sessionId
}

function toolContent(payload) {
  const text = payload?.result?.content?.find((item) => item?.type === 'text')?.text
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw upstreamError('HubSpot MCP tool returned invalid JSON.', error)
  }
}

async function callTool(config, token, sessionId, id, name, args) {
  const { payload } = await postMcp(config, token, {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }, sessionId)
  if (payload?.result?.isError) {
    const message = payload.result.content?.find((item) => item?.type === 'text')?.text
    throw upstreamError(message || `HubSpot MCP tool ${name} failed.`)
  }
  return toolContent(payload)
}

const normalizeLabel = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

async function readDealsWithToken(config, token) {
  const sessionId = await connect(config, token)
  const metadata = await callTool(config, token, sessionId, 3, 'get_properties', {
    objectType: 'deals', propertyNames: ['dealstage', 'pipeline'],
  })
  const allMetadata = await callTool(config, token, sessionId, 4, 'search_properties', {
    objectType: 'deals',
  })
  const definitions = Object.fromEntries((metadata.results || []).map((item) => [item.name, item]))
  const definitionsByLabel = new Map((allMetadata.results || []).map((item) => [normalizeLabel(item.label), item]))
  const stageLabels = Object.fromEntries((definitions.dealstage?.options || []).map((item) => [String(item.value), String(item.label)]))
  const pipelineLabels = Object.fromEntries((definitions.pipeline?.options || []).map((item) => [String(item.value), String(item.label)]))
  const pipelineId = Object.entries(pipelineLabels).find(([, label]) => label.trim().toLowerCase() === 'deal pipeline')?.[0]
  if (!pipelineId) throw upstreamError('Deal Pipeline was not found in HubSpot metadata.')

  const selected = {}
  for (const label of DEAL_COLUMNS) {
    const definition = definitionsByLabel.get(normalizeLabel(label))
    if (definition?.name) selected[definition.name] = label
  }
  Object.assign(selected, {
    dealname: 'Deal Name', dealstage: 'Deal Stage', hubspot_owner_id: 'Deal Owner',
    amount: 'Amount', closedate: 'Close Date', description: 'Description',
  })

  const items = []
  let offset
  let total
  do {
    const args = {
      objectType: 'deals', properties: Object.keys(selected),
      filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipelineId }] }],
      sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }], limit: 200,
      chatInsights: { userIntent: 'Review deal pipeline', satisfaction: 'NEUTRAL' },
    }
    if (offset !== undefined && offset !== null) args.offset = offset
    const page = await callTool(config, token, sessionId, 10 + items.length, 'search_crm_objects', args)
    items.push(...(page.results || []))
    total = page.total ?? total
    offset = page.offset
  } while (offset !== undefined && offset !== null && items.length < Number(total || 0))

  const ownerFields = Object.entries(selected).filter(([, label]) => label.toLowerCase().includes('owner')).map(([name]) => name)
  const ownerIds = [...new Set(items.flatMap((item) => ownerFields.map((field) => item.properties?.[field]))
    .filter((value) => /^\d+$/.test(String(value))).map(Number))].sort((a, b) => a - b)
  const ownerNames = {}
  for (let index = 0; index < ownerIds.length; index += 100) {
    const result = await callTool(config, token, sessionId, 1000 + index, 'search_owners', {
      ownerIds: ownerIds.slice(index, index + 100), limit: 100,
    })
    for (const owner of result.results || result.owners || []) {
      const id = String(owner.id ?? owner.ownerId ?? '')
      const name = String(owner.name || '').trim() || [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim()
      ownerNames[id] = name || owner.email || 'Unassigned'
    }
  }

  const deals = items.map((item) => Object.fromEntries(Object.entries(selected).map(([internal, label]) => {
    let value = item.properties?.[internal]
    if (internal === 'dealstage') value = stageLabels[String(value)] || 'Unknown'
    else if (ownerFields.includes(internal)) value = ownerNames[String(value)] || 'Unassigned'
    return [label, value === '' || value === undefined ? null : value]
  })))
  const won = deals.filter((deal) => String(deal['Deal Stage'] || '').trim().toLowerCase() === 'closed won')
  return {
    available_columns: Object.values(selected),
    summary: { pipeline: 'Deal Pipeline', total_deals: deals.length, closed_won_deals: won.length },
    deals,
  }
}

export async function readHubSpotDeals() {
  const config = getConfig()
  let token = await getAccessToken(config)
  try {
    return await readDealsWithToken(config, token)
  } catch (error) {
    if (error?.upstreamStatus !== 401 || !config.refreshToken) throw error
    token = await getAccessToken(config, true)
    return readDealsWithToken(config, token)
  }
}

