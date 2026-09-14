import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { handleHubMcpRequest, hubMcpKeyAccepted, HUB_MCP_ACTOR_ID } from '../src/services/hubMcp.js'
import hubMcpRouter from '../src/routes/hubMcp.js'

const catalog = [
  { id: 'trusted-tech-hubspot-assistant', name: 'Hubspot', status: 'active', productArea: 'Operations Assistant', summary: 'Deals.' },
  { id: 'grant-application-agent', name: 'Grant Application Agent', status: 'planned', productArea: 'Grants', summary: '' },
]

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

async function connect(url, key) {
  const client = new Client({ name: 'test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  })
  await client.connect(transport)
  return client
}

test('the key gate fails closed: unset, missing and wrong keys are all refused', () => {
  assert.equal(hubMcpKeyAccepted('Bearer anything', ''), false)
  assert.equal(hubMcpKeyAccepted('Bearer anything', undefined), false)
  assert.equal(hubMcpKeyAccepted('', 'secret'), false)
  assert.equal(hubMcpKeyAccepted('Bearer nope', 'secret'), false)
  assert.equal(hubMcpKeyAccepted('Basic secret', 'secret'), false)
  assert.equal(hubMcpKeyAccepted('Bearer secret', 'secret'), true)
})

test('the route answers 401 to a caller without the key, before any MCP handling', async () => {
  process.env.HUB_MCP_KEY = 'test-key'
  const app = express()
  app.use(express.json())
  app.use('/hub-mcp', hubMcpRouter)
  const { server, url } = await listen(app)
  try {
    const response = await fetch(`${url}/hub-mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    assert.equal(response.status, 401)
  } finally {
    server.close()
    delete process.env.HUB_MCP_KEY
  }
})

test('a Hermes-style client lists the active agents and asks one through the shared runner', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    return { message: { role: 'assistant', content: 'Three deals moved to Closed Won.' }, meta: { provider: 'hermes' } }
  }
  const deps = {
    run,
    agents: async () => catalog,
    agent: async (id) => catalog.find((item) => item.id === id) || null,
  }
  const app = express()
  app.use(express.json())
  app.post('/hub-mcp', (req, res, next) => handleHubMcpRequest(req, res, deps).catch(next))
  const { server, url } = await listen(app)
  try {
    const client = await connect(`${url}/hub-mcp`, 'irrelevant-here')

    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'ask_agent', 'list_agents',
      'map_agency', 'map_call_activity', 'map_recent_calls', 'map_research_runs', 'map_search_agencies',
    ])

    const listed = await client.callTool({ name: 'list_agents', arguments: {} })
    // Planned agents have no skill to run yet, so they are not offered.
    assert.deepEqual(listed.structuredContent.agents.map((agent) => agent.id), ['trusted-tech-hubspot-assistant'])

    const asked = await client.callTool({
      name: 'ask_agent',
      arguments: {
        agent_id: 'trusted-tech-hubspot-assistant',
        message: 'What closed this week?',
        history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      },
    })
    assert.equal(asked.isError, undefined)
    assert.equal(asked.content[0].text, 'Three deals moved to Closed Won.')
    assert.equal(asked.structuredContent.agent_name, 'Hubspot')

    // The runner saw the history plus the new turn, attributed to the service
    // identity -- no Auth0 user, no permissions, so public memory only.
    assert.equal(calls.length, 1)
    assert.equal(calls[0].agentId, 'trusted-tech-hubspot-assistant')
    assert.deepEqual(calls[0].messages.map((m) => m.content), ['hi', 'hello', 'What closed this week?'])
    assert.equal(calls[0].user.id, HUB_MCP_ACTOR_ID)
    assert.deepEqual(calls[0].user.payload.permissions, [])

    const unknown = await client.callTool({ name: 'ask_agent', arguments: { agent_id: 'nope', message: 'x' } })
    assert.equal(unknown.isError, true)
    assert.match(unknown.content[0].text, /Unknown agent/)

    const planned = await client.callTool({ name: 'ask_agent', arguments: { agent_id: 'grant-application-agent', message: 'x' } })
    assert.equal(planned.isError, true)
    assert.match(planned.content[0].text, /planned/)

    await client.close()
  } finally {
    server.close()
  }
})

test('an agent failure comes back as a tool error, not a transport error', async () => {
  const deps = {
    run: async () => { throw new Error('Hermes took too long to respond.') },
    agents: async () => catalog,
    agent: async (id) => catalog.find((item) => item.id === id) || null,
  }
  const app = express()
  app.use(express.json())
  app.post('/hub-mcp', (req, res, next) => handleHubMcpRequest(req, res, deps).catch(next))
  const { server, url } = await listen(app)
  try {
    const client = await connect(`${url}/hub-mcp`, 'k')
    const result = await client.callTool({ name: 'ask_agent', arguments: { agent_id: 'trusted-tech-hubspot-assistant', message: 'x' } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /Hubspot could not answer: Hermes took too long/)
    await client.close()
  } finally {
    server.close()
  }
})

test('the map tools are read-only views that pass the caller\'s scope through untouched', async () => {
  const seen = {}
  const map = {
    callActivity: async (args) => { seen.callActivity = args; return { scope: 'States: TX', totals: { calls: 7 }, byRep: [{ rep: 'troy@trustedtechnology.ai', calls: 7 }] } },
    recentCalls: async (args) => { seen.recentCalls = args; return { count: 1, calls: [{ ori: 'TX1', outcome: 'Left voicemail', loggedBy: 'troy@trustedtechnology.ai' }] } },
    searchAgencies: async (args) => { seen.searchAgencies = args; return { total: 1, returned: 1, agencies: [{ ori: 'TX1', name: 'Pampa PD' }] } },
    agency: async ({ ori }) => (ori === 'TX1' ? { ori, name: 'Pampa PD', calls: [] } : null),
    researchRuns: async (args) => { seen.researchRuns = args; return [{ id: 'r1', status: 'finished' }] },
  }
  const deps = { run: async () => ({}), agents: async () => catalog, agent: async () => null, map }
  const app = express()
  app.use(express.json())
  app.post('/hub-mcp', (req, res, next) => handleHubMcpRequest(req, res, deps).catch(next))
  const { server, url } = await listen(app)
  try {
    const client = await connect(`${url}/hub-mcp`, 'k')

    const activity = await client.callTool({ name: 'map_call_activity', arguments: { from: '2026-09-14', to: '2026-09-14', state: 'TX' } })
    assert.equal(activity.structuredContent.totals.calls, 7)
    assert.deepEqual(seen.callActivity, { from: '2026-09-14', to: '2026-09-14', state: 'TX' })

    const calls = await client.callTool({ name: 'map_recent_calls', arguments: { sdr: 'troy', limit: 10 } })
    assert.equal(calls.structuredContent.calls[0].loggedBy, 'troy@trustedtechnology.ai')
    assert.equal(seen.recentCalls.sdr, 'troy')

    // The schema is the gate: a limit past the cap never reaches the query.
    const tooMany = await client.callTool({ name: 'map_recent_calls', arguments: { limit: 5000 } })
    assert.equal(tooMany.isError, true)

    const found = await client.callTool({ name: 'map_search_agencies', arguments: { state: 'TX', bwc: 'unknown', minOfficers: 10 } })
    assert.equal(found.structuredContent.agencies[0].name, 'Pampa PD')
    assert.deepEqual(seen.searchAgencies, { state: 'TX', bwc: 'unknown', minOfficers: 10 })

    const one = await client.callTool({ name: 'map_agency', arguments: { ori: 'TX1' } })
    assert.equal(one.structuredContent.name, 'Pampa PD')
    const none = await client.callTool({ name: 'map_agency', arguments: { ori: 'XX9' } })
    assert.equal(none.isError, true)

    const runs = await client.callTool({ name: 'map_research_runs', arguments: {} })
    assert.equal(runs.structuredContent.items[0].status, 'finished')

    await client.close()
  } finally {
    server.close()
  }
})
