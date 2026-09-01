/**
 * Finds who currently leads an agency: the chief or sheriff, plus their
 * assistant/deputy chiefs.
 *
 * No public dataset carries this. It changes constantly - sheriffs are elected,
 * chiefs are appointed and replaced - so a name is worth nothing without a
 * source and a date attached. Both are stored, and anything the model cannot
 * cite is discarded rather than written.
 *
 * Same discipline as agencyBriefing.js: search is required rather than
 * optional, so the model cannot answer from memory, and every claim must carry
 * the URL it was read on.
 */
import LeAgency from '../models/LeAgency.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const MODEL = process.env.AGENCY_LEADERSHIP_MODEL || 'gpt-4.1'
const REQUEST_TIMEOUT_MS = Number(process.env.AGENCY_LEADERSHIP_TIMEOUT_MS || 120000)
const MAX_TOOL_CALLS = Number(process.env.AGENCY_LEADERSHIP_MAX_TOOL_CALLS || 8)
// Leadership changes, but not weekly. Re-verify on this cadence.
const MAX_AGE_MS = Number(process.env.AGENCY_LEADERSHIP_MAX_AGE_MS || 90 * 24 * 60 * 60 * 1000)

const LEADERSHIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chiefName: {
      type: 'string',
      description: 'Full name of the current chief or sheriff. Empty string if not found on a page you read.',
    },
    chiefTitle: {
      type: 'string',
      description: 'Their exact title, e.g. "Sheriff", "Chief of Police", "Interim Chief". Empty if unknown.',
    },
    chiefSourceUrl: {
      type: 'string',
      description: 'Exact URL the name was read on. Empty string if none - in which case chiefName must also be empty.',
    },
    commandStaff: {
      type: 'array',
      description: 'Assistant chiefs, deputy chiefs, chief deputies and majors. Empty array if none found.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          sourceUrl: { type: 'string' },
        },
        required: ['name', 'title', 'sourceUrl'],
      },
    },
    website: {
      type: 'string',
      description: "The agency's official website. Empty string if not confirmed.",
    },
    phone: {
      type: 'string',
      description: 'Main non-emergency phone number as published. Empty string if not confirmed.',
    },
    email: {
      type: 'string',
      description:
        "The agency's published general contact email, e.g. info@ or records@. Never an individual " +
        "officer's personal address. Empty string if the page publishes none.",
    },
    asOf: {
      type: 'string',
      description: 'Date the source page states this leadership is current, YYYY-MM or YYYY-MM-DD. Empty if the page gives none.',
    },
  },
  required: ['chiefName', 'chiefTitle', 'chiefSourceUrl', 'commandStaff', 'website', 'phone', 'email', 'asOf'],
}

const ACCURACY_RULES = [
  'ACCURACY RULES, these override everything else:',
  '1. Report only what you actually read on a page you opened. Never infer from what similar agencies typically do, and never answer from memory.',
  '2. Every name must carry the exact URL you read it on. If you cannot cite it, return an empty string - an empty answer is correct and useful.',
  '3. Agency names repeat across states. Confirm the state AND county match before trusting a source.',
  '4. Prefer the agency\'s own site or its county/city government site over news articles and directories.',
  '5. Leadership changes often. If a page looks outdated or you find conflicting names, prefer the most recently dated source and say nothing rather than guessing.',
  '6. Do not return a predecessor. If the page describes someone as former, retired, or a candidate, that is not the current holder.',
].join(' ')

async function callOpenAI(body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text()
      throw Object.assign(new Error(text || `OpenAI request failed with ${response.status}`), {
        statusCode: response.status,
      })
    }
    return response.json()
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Leadership lookup timed out while searching.'), {
        statusCode: 504,
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function getTextFromResponse(payload) {
  if (!Array.isArray(payload?.output)) return ''
  return payload.output
    .flatMap((item) => {
      if (item?.type !== 'message' || !Array.isArray(item.content)) return []
      return item.content
        .filter((c) => c?.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text)
    })
    .join('\n')
}

const isUrl = (value) => /^https?:\/\//i.test(String(value || '').trim())

// Sources publish these every way imaginable - "254.953.5400", "(254) 336-2810",
// and hyphens that are not ASCII hyphens. Store one shape so the column sorts,
// dedupes and dials.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (local.length !== 10) return ''
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
}

// Only an agency-level address. A named individual's mailbox is not ours to
// collect from a public page and put in a prospecting list.
const PERSONAL_EMAIL = /^(?!(?:info|contact|police|sheriff|records|admin|general|inquiries|dispatch|pd|so|office|mail)@)[a-z]+[._-][a-z]+@/i

function cleanEmail(raw) {
  const email = String(raw || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) return ''
  if (PERSONAL_EMAIL.test(email)) return ''
  return email
}

/**
 * Researches one agency. Returns the fields to write, already filtered so an
 * uncited name never reaches the database.
 */
export async function researchLeadership(agency) {
  const where = [agency.county ? `${agency.county} County` : '', agency.stateName || agency.state]
    .filter(Boolean)
    .join(', ')

  const identity = [
    `Agency: ${agency.agencyName}`,
    `Location: ${where}`,
    agency.agencyType ? `Type: ${agency.agencyType}` : '',
    agency.contacts?.streetAddress?.city
      ? `Address on file: ${[agency.contacts.streetAddress.line1, agency.contacts.streetAddress.city]
          .filter(Boolean)
          .join(', ')}`
      : '',
    `ORI: ${agency.ori}`,
  ]
    .filter(Boolean)
    .join('\n')

  const payload = await callOpenAI({
    model: MODEL,
    tools: [{ type: 'web_search' }],
    // Required, not auto: without this the model answers from memory, which is
    // exactly the unsourced output this must never produce.
    tool_choice: 'required',
    max_tool_calls: MAX_TOOL_CALLS,
    text: { format: { type: 'json_schema', name: 'agency_leadership', strict: true, schema: LEADERSHIP_SCHEMA } },
    input: [
      {
        role: 'system',
        content: `You research US law enforcement agency leadership for a body-worn camera vendor. ${ACCURACY_RULES}`,
      },
      {
        role: 'user',
        content:
          `${identity}\n\n` +
          'Who currently leads this agency? Find the chief of police or sheriff by name and exact title, ' +
          'and any assistant chiefs, deputy chiefs or chief deputies listed. Also capture the official ' +
          'website, main non-emergency phone number, and the general contact email if the page ' +
          'states them.',
      },
    ],
  })

  let parsed = null
  try {
    parsed = JSON.parse(getTextFromResponse(payload))
  } catch {
    parsed = null
  }
  if (!parsed) return { status: 'unparsed', searches: 0 }

  const searches = Array.isArray(payload?.output)
    ? payload.output.filter((item) => item?.type === 'web_search_call').length
    : 0

  // A name without a source is exactly the failure mode this exists to avoid.
  const chiefCited = Boolean(parsed.chiefName?.trim()) && isUrl(parsed.chiefSourceUrl)
  const commandStaff = (Array.isArray(parsed.commandStaff) ? parsed.commandStaff : [])
    .filter((person) => person?.name?.trim() && isUrl(person.sourceUrl))
    .slice(0, 8)

  return {
    status: chiefCited ? 'ok' : 'not-found',
    searches,
    chiefName: chiefCited ? parsed.chiefName.trim() : '',
    chiefTitle: chiefCited ? String(parsed.chiefTitle || '').trim() : '',
    chiefSourceUrl: chiefCited ? parsed.chiefSourceUrl.trim() : '',
    commandStaff: commandStaff.map((person) => ({
      name: person.name.trim(),
      title: String(person.title || '').trim(),
      sourceUrl: person.sourceUrl.trim(),
      verifiedAt: new Date(),
    })),
    website: isUrl(parsed.website) ? parsed.website.trim() : '',
    phone: normalizePhone(parsed.phone),
    email: cleanEmail(parsed.email),
    asOf: String(parsed.asOf || '').trim(),
  }
}

/** Writes a researched result, leaving untouched anything that came back empty. */
export async function saveLeadership(ori, result) {
  const now = new Date()
  const set = {
    'enrichment.leadershipStatus': result.status,
    'enrichment.leadershipCheckedAt': now,
  }

  if (result.status === 'ok') {
    set['contacts.chiefName'] = result.chiefName
    set['contacts.chiefTitle'] = result.chiefTitle
    set['contacts.chiefSourceUrl'] = result.chiefSourceUrl
    set['contacts.chiefVerifiedAt'] = now
  }
  if (result.commandStaff?.length) set['contacts.commandStaff'] = result.commandStaff
  // Only fill contact details, never blank an existing one on a quiet result.
  if (result.website) set['contacts.website'] = result.website
  if (result.phone) set['contacts.phone'] = result.phone
  if (result.email) set['contacts.email'] = result.email

  await LeAgency.updateOne({ ori }, { $set: set })
}

/** True when this agency has been checked recently enough to skip. */
export function isFresh(agency) {
  const checked = agency?.enrichment?.leadershipCheckedAt
  return Boolean(checked) && Date.now() - new Date(checked).getTime() < MAX_AGE_MS
}
