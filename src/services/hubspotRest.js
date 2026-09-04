/**
 * HubSpot's CRM API, called directly with a private app token.
 *
 * Not through the MCP and not through Hermes. HubSpot's hosted MCP exposes 22
 * tools and none of them create CRM records - the write tools it does have are
 * for campaigns, landing pages and marketing email. So the only way to create a
 * company or a contact is the REST API, which is also the simpler thing: two
 * HTTP calls, no gateway, no agent choosing what to write.
 */
const BASE = 'https://api.hubapi.com'
const TIMEOUT_MS = Number(process.env.HUBSPOT_REST_TIMEOUT_MS || 20000)

const token = () => {
  const value = String(process.env.HUBSPOT_API_TOKEN || process.env.HUBSPOT_PRIVATE_APP_TOKEN || '').trim()
  if (!value) {
    const error = new Error(
      'HUBSPOT_API_TOKEN is not set. Create a HubSpot service key (or legacy private app) ' +
        'with crm.objects.companies.write and crm.objects.contacts.write.',
    )
    error.statusCode = 503
    throw error
  }
  return value
}

/**
 * One HubSpot call.
 *
 * HubSpot's errors are genuinely useful - a missing scope names the scope, a
 * bad property names the property - so the message is surfaced rather than
 * flattened into "request failed". That message ends up in front of whoever
 * clicked Save, and it is usually the whole fix.
 */
async function call(method, path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('HubSpot took too long to respond.')
    throw error
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  if (!response.ok) {
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text)
      detail = parsed.message || detail
      // A missing scope is the single most likely failure on first use, and
      // HubSpot says exactly which one is absent. Keep that.
      if (parsed.errors?.length) {
        detail += ` (${parsed.errors.map((e) => e.message).join('; ')})`
      }
    } catch {
      /* keep the raw body */
    }
    const error = new Error(`HubSpot ${response.status}: ${detail}`)
    error.statusCode = response.status
    throw error
  }
  return text ? JSON.parse(text) : {}
}

/** Find one record by an exact property match. Returns its id, or ''. */
export async function findRecord(objectType, propertyName, value) {
  if (!value) return ''
  const result = await call('POST', `/crm/v3/objects/${objectType}/search`, {
    filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
    properties: ['hs_object_id'],
    limit: 1,
  })
  return String(result.results?.[0]?.id || '')
}

/** Read specific properties off one record. */
export async function readRecord(objectType, id, properties = []) {
  if (!id) return {}
  const query = properties.length ? `?properties=${properties.join(',')}` : ''
  const result = await call('GET', `/crm/v3/objects/${objectType}/${id}${query}`)
  return result.properties || {}
}

/**
 * Create the record, or patch it when we already know its id.
 *
 * One function rather than two so callers cannot accidentally create a second
 * copy of something they already have - which is the failure that matters here,
 * because a duplicated company is quiet and only noticed later.
 */
export async function upsertRecord(objectType, properties, existingId = '') {
  if (existingId) {
    const updated = await call('PATCH', `/crm/v3/objects/${objectType}/${existingId}`, {
      properties,
    })
    return String(updated.id || existingId)
  }
  const created = await call('POST', `/crm/v3/objects/${objectType}`, { properties })
  return String(created.id || '')
}

/**
 * Link a contact to a company.
 *
 * Uses the default association labels endpoint, so HubSpot picks the standard
 * contact-to-company type rather than us hardcoding a numeric id that differs
 * between portals.
 */
export async function associate(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return
  await call('PUT', `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`)
}

/** Cheap credential check: who am I, and does the token work at all. */
export async function checkToken() {
  const result = await call('GET', '/crm/v3/objects/companies?limit=1')
  return { ok: true, sampleCount: (result.results || []).length }
}
