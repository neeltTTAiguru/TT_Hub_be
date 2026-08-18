// On-demand check: does the Hermes gateway actually expose the HubSpot MCP tools?
//
// The gateway drops a failed MCP server silently — `hermes mcp list` still shows
// hubspot "enabled" and /health still returns ok — so this probe is the only
// cheap way to know. Run it after any Hermes/container restart.
//
//   npm run hubspot:check
import 'dotenv/config'
import { probeHubSpotTools } from '../src/services/hubspotHealth.js'

const result = await probeHubSpotTools()
if (result.status === 'ok') {
  console.log(`OK — HubSpot tools are live (hub ${result.hubId}).`)
  process.exit(0)
}
if (result.status === 'down') {
  console.error('DOWN — the Hermes gateway has NO mcp__hubspot__* tools.')
  console.error(result.error)
  console.error('\nFix: restart the gateway on the droplet, then re-run this check:')
  console.error("  ssh root@147.182.234.139 'docker exec hermes /command/s6-svc -r /run/service/gateway-default'")
  process.exit(1)
}
console.error(`INDETERMINATE — could not reach the gateway: ${result.error}`)
process.exit(2)
