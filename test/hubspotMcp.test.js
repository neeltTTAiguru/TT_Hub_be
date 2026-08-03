import test from 'node:test'
import assert from 'node:assert/strict'
import { readHubSpotDeals } from '../src/services/hubspotMcp.js'

function mcpResponse(payload, sessionId = '') {
  const headers = { 'Content-Type': 'application/json' }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  return new Response(JSON.stringify(payload), { status: 200, headers })
}

test('reads and translates the Deal Pipeline directly through MCP', async () => {
  const originalFetch = global.fetch
  const originalUrl = process.env.HUBSPOT_MCP_URL
  const originalToken = process.env.HUBSPOT_MCP_ACCESS_TOKEN
  process.env.HUBSPOT_MCP_URL = 'https://hubspot-mcp.example.test/mcp'
  process.env.HUBSPOT_MCP_ACCESS_TOKEN = 'test-token'

  const calls = []
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body)
    calls.push(request)
    if (request.method === 'initialize') {
      return mcpResponse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }, 'session-1')
    }
    if (request.method === 'notifications/initialized') return mcpResponse({})
    const tool = request.params.name
    if (tool === 'get_properties') {
      return mcpResponse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({
        results: [
          { name: 'dealstage', options: [{ value: 'won', label: 'Closed Won' }] },
          { name: 'pipeline', options: [{ value: 'primary', label: 'Deal Pipeline' }] },
        ],
      }) }] } })
    }
    if (tool === 'search_properties') {
      return mcpResponse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({
        results: [
          { name: 'dealname', label: 'Deal Name' },
          { name: 'dealstage', label: 'Deal Stage' },
          { name: 'hubspot_owner_id', label: 'Deal Owner' },
        ],
      }) }] } })
    }
    if (tool === 'search_crm_objects') {
      return mcpResponse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({
        total: 1,
        results: [{ properties: { dealname: 'Example Agency', dealstage: 'won', hubspot_owner_id: '42' } }],
      }) }] } })
    }
    if (tool === 'search_owners') {
      return mcpResponse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({
        results: [{ id: '42', firstName: 'Alex', lastName: 'Seller' }],
      }) }] } })
    }
    throw new Error(`Unexpected MCP request: ${JSON.stringify(request)}`)
  }

  try {
    const result = await readHubSpotDeals()
    assert.deepEqual(result.summary, { pipeline: 'Deal Pipeline', total_deals: 1, closed_won_deals: 1 })
    assert.equal(result.deals[0]['Deal Name'], 'Example Agency')
    assert.equal(result.deals[0]['Deal Stage'], 'Closed Won')
    assert.equal(result.deals[0]['Deal Owner'], 'Alex Seller')
    assert.equal(calls.filter((call) => call.method === 'tools/call').length, 4)
  } finally {
    global.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.HUBSPOT_MCP_URL
    else process.env.HUBSPOT_MCP_URL = originalUrl
    if (originalToken === undefined) delete process.env.HUBSPOT_MCP_ACCESS_TOKEN
    else process.env.HUBSPOT_MCP_ACCESS_TOKEN = originalToken
  }
})

