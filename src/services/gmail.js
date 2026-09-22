/**
 * Each person's own Gmail, used only to send as them.
 *
 * Google OAuth with a refresh token per member, stored encrypted on their
 * HubMember record. Scopes are send and read-only: the hub sends as them and
 * shows them their inbox, and cannot delete, label or move anything. Plain
 * fetch against Google's endpoints rather than the googleapis SDK - a handful
 * of calls do not need a client library.
 *
 * Also the only place the Google connection itself lives. Calendar rides on
 * the same grant and the same refresh token - one "Connect Google", not two -
 * so services/calendar.js borrows `googleAccessToken` and the scope list from
 * here rather than running a second OAuth flow of its own.
 *
 * Environment:
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET - the Web application
 *     client from Google Cloud Console, Internal to the Workspace.
 *   GOOGLE_OAUTH_REDIRECT_URI - this API's /gmail/callback, as registered on
 *     that client. Defaults to production; local .env points it at localhost.
 *   GMAIL_TOKEN_KEY - 32+ characters; encrypts the stored refresh tokens.
 *   HUB_FRONTEND_URL - where the browser is sent back to after consent.
 */
import crypto from 'node:crypto'
import HubMember from '../models/HubMember.js'
import EmailTemplate from '../models/EmailTemplate.js'

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly']

/**
 * Calendar: view and edit events on the calendars they can already reach.
 *
 * Deliberately `calendar.events` and not `calendar`: it is enough to read the
 * month and to add, move and cancel an appointment, and it cannot create or
 * delete a calendar or change who it is shared with. It does not grant the
 * calendar *list* either, which is why the page works one calendar at a time
 * and that calendar is `primary`.
 */
export const CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events']

const SCOPES = [...GMAIL_SCOPES, ...CALENDAR_SCOPES]
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'

const env = () => ({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || '',
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || '',
  // Production unless told otherwise. This defaulted to localhost, DO never
  // had the variable, and Troy got "Error 400: redirect_uri_mismatch" from
  // Google on the hosted hub. Local development sets it in .env.
  redirectUri:
    process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
    'https://trusted-hub-be-piemr.ondigitalocean.app/gmail/callback',
  frontendUrl: (process.env.HUB_FRONTEND_URL?.trim() || 'https://trusted-fe-hub-agl8a.ondigitalocean.app').replace(/\/$/, ''),
  tokenKey: process.env.GMAIL_TOKEN_KEY?.trim() || '',
})

export const isConfigured = () => {
  const { clientId, clientSecret, tokenKey } = env()
  return Boolean(clientId && clientSecret && tokenKey.length >= 32)
}

const notConfigured = () =>
  Object.assign(
    new Error(
      'Gmail is not configured on the server. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GMAIL_TOKEN_KEY.',
    ),
    { statusCode: 503 },
  )

// AES-256-GCM with a key derived from GMAIL_TOKEN_KEY. A refresh token is a
// standing credential for someone's mailbox; it does not sit in Mongo in
// the clear.
const keyBytes = () => crypto.createHash('sha256').update(env().tokenKey).digest()

const encrypt = (text) => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv)
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`
}

const decrypt = (blob) => {
  const [iv, tag, enc] = String(blob).split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8')
}

// The OAuth state carries who started the flow, signed, so the callback -
// which arrives from Google with no Auth0 session - can tell whose token it
// is holding without trusting anything Google echoes back.
const sign = (payload) =>
  crypto.createHmac('sha256', env().tokenKey).update(payload).digest('base64url')

/**
 * `returnTo` is the hub page the person pressed Connect on - 'gmail' or
 * 'calendar'. It rides inside the signed state so the callback, which has no
 * session to ask, puts them back where they were instead of always on Gmail.
 */
export function connectUrl(email, returnTo = 'gmail') {
  if (!isConfigured()) throw notConfigured()
  const to = RETURN_PAGES.includes(returnTo) ? returnTo : 'gmail'
  const payload = Buffer.from(JSON.stringify({ email, to, at: Date.now() })).toString('base64url')
  const state = `${payload}.${sign(payload)}`
  const params = new URLSearchParams({
    client_id: env().clientId,
    redirect_uri: env().redirectUri,
    response_type: 'code',
    scope: ['openid', 'email', ...SCOPES].join(' '),
    access_type: 'offline',
    // Google only returns a refresh token on the first consent unless asked
    // again; ask every time so a reconnect always yields one.
    prompt: 'consent',
    include_granted_scopes: 'true',
    login_hint: email,
    state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

/** The hub pages a consent flow may be sent back to. Anything else is Gmail. */
export const RETURN_PAGES = ['gmail', 'calendar']

export function readState(state) {
  const [payload, mac] = String(state || '').split('.')
  if (!payload || !mac || sign(payload) !== mac) throw Object.assign(new Error('Bad state.'), { statusCode: 400 })
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (Date.now() - parsed.at > 15 * 60 * 1000) throw Object.assign(new Error('That link expired. Start again.'), { statusCode: 400 })
  return { ...parsed, to: RETURN_PAGES.includes(parsed.to) ? parsed.to : 'gmail' }
}

const tokenRequest = async (body) => {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(data.error_description || data.error || `Google token error ${response.status}`), {
      statusCode: 502,
      code: data.error,
    })
  }
  return data
}

/** Finish the consent flow: exchange the code, learn the address, store the token. */
export async function completeConnect(email, code) {
  if (!isConfigured()) throw notConfigured()
  const { clientId, clientSecret, redirectUri } = env()
  const token = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  if (!token.refresh_token) {
    throw Object.assign(new Error('Google did not return a refresh token. Remove the hub from your Google account permissions and connect again.'), { statusCode: 502 })
  }
  const who = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token.access_token}` } })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
  const address = String(who.email || '').toLowerCase()
  // The mailbox connected has to be the person signed in. Connecting
  // somebody else's Gmail to your hub account is exactly the thing this
  // check exists to refuse.
  if (address && address !== email) {
    throw Object.assign(new Error(`You are signed in to the hub as ${email} but connected ${address}. Connect the same account.`), { statusCode: 400 })
  }
  await HubMember.updateOne(
    { email },
    {
      $set: {
        'gmail.address': address || email,
        'gmail.refreshToken': encrypt(token.refresh_token),
        'gmail.scopes': String(token.scope || '').split(' ').filter(Boolean),
        'gmail.connectedAt': new Date(),
        'gmail.lastError': '',
      },
      $setOnInsert: { email },
    },
    { upsert: true },
  )
  return address || email
}

export async function disconnect(email) {
  const member = await HubMember.findOne({ email }).select('gmail').lean()
  if (member?.gmail?.refreshToken) {
    // Best effort: tell Google too, so the grant disappears from their account page.
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(member.gmail.refreshToken))}`, { method: 'POST' })
    } catch {
      /* the local record is cleared regardless */
    }
  }
  await HubMember.updateOne(
    { email },
    { $set: { gmail: { address: '', refreshToken: '', scopes: [], connectedAt: null, lastError: '' } } },
  )
}

/**
 * Whether this member's stored grant covers Calendar.
 *
 * Everyone who connected before Calendar was added has a perfectly good
 * refresh token that Google will refuse calendar calls with. Reading the
 * scopes we recorded at consent tells the page to offer a reconnect instead
 * of showing an empty calendar and a 403.
 */
export const hasCalendarScope = (member) =>
  CALENDAR_SCOPES.every((scope) => (member?.gmail?.scopes || []).includes(scope))

export const statusFor = (member) => ({
  configured: isConfigured(),
  connected: Boolean(member?.gmail?.refreshToken),
  address: member?.gmail?.address || '',
  connectedAt: member?.gmail?.connectedAt || null,
  lastError: member?.gmail?.lastError || '',
  calendar: Boolean(member?.gmail?.refreshToken) && hasCalendarScope(member),
})

async function accessTokenFor(member) {
  if (!isConfigured()) throw notConfigured()
  if (!member?.gmail?.refreshToken) {
    throw Object.assign(new Error('Connect your Gmail first.'), { statusCode: 409 })
  }
  const { clientId, clientSecret } = env()
  try {
    const token = await tokenRequest({
      refresh_token: decrypt(member.gmail.refreshToken),
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    })
    return token.access_token
  } catch (error) {
    // A revoked grant is permanent; say so on the record so the button
    // offers a reconnect rather than failing quietly every time.
    if (error.code === 'invalid_grant') {
      await HubMember.updateOne({ email: member.email }, { $set: { 'gmail.lastError': 'Google revoked the connection. Connect again.' } })
      throw Object.assign(new Error('Your Gmail connection was revoked. Connect it again.'), { statusCode: 409 })
    }
    throw error
  }
}

/**
 * A live access token for this member's Google grant, for any Google API.
 *
 * Exported for services/calendar.js. Refreshing, the encrypted token and the
 * revoked-grant handling all live here, and there is exactly one grant per
 * member, so a second copy of this in the calendar service would be a second
 * thing to get wrong.
 */
export const googleAccessToken = (member) => accessTokenFor(member)

const encodeHeader = (value) => `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`

const gmailFetch = async (member, path, init = {}) => {
  const accessToken = await accessTokenFor(member)
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(data.error?.message || `Gmail error ${response.status}.`), { statusCode: 502 })
  }
  return data
}

/**
 * Send a plain-text email as the member. Returns Gmail's message id.
 * With `thread` it goes out as a reply, threaded under the original.
 */
export async function sendAsMember(member, { to, cc = [], subject, text, fromName = '', thread = null }) {
  const from = fromName ? `${encodeHeader(fromName)} <${member.gmail.address}>` : member.gmail.address
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ]
  if (thread?.messageId) {
    headers.push(`In-Reply-To: ${thread.messageId}`, `References: ${thread.references || thread.messageId}`)
  }
  const mime = [...headers, '', Buffer.from(String(text), 'utf8').toString('base64')].join('\r\n')
  const data = await gmailFetch(member, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url'), ...(thread?.threadId ? { threadId: thread.threadId } : {}) }),
  })
  return data.id
}

// Gmail's snippet is HTML-escaped; the list shows it as text.
const unescape = (text) =>
  String(text || '')
    .replace(/&#(\d+);/g, (m, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')

const header = (message, name) =>
  (message.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''

/** The folders the page offers, as Gmail's system labels. Anything else is Inbox. */
export const FOLDERS = { inbox: 'INBOX', starred: 'STARRED', sent: 'SENT', drafts: 'DRAFT' }

/**
 * A page of one folder: newest first, headers and snippet only.
 *
 * `total` is Gmail's own estimate for the folder (or the search), which is
 * what its "1-50 of 1,091" shows too - it is an estimate there as well.
 */
export async function listInbox(member, { q = '', pageToken = '', max = 50, folder = 'inbox' } = {}) {
  const label = FOLDERS[folder] || FOLDERS.inbox
  const params = new URLSearchParams({ maxResults: String(max), labelIds: label })
  if (q) params.set('q', q)
  if (pageToken) params.set('pageToken', pageToken)
  const list = await gmailFetch(member, `/messages?${params.toString()}`)
  const ids = (list.messages || []).map((m) => m.id)
  const messages = await Promise.all(
    ids.map((id) =>
      gmailFetch(member, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`),
    ),
  )
  return {
    nextPageToken: list.nextPageToken || '',
    total: Number(list.resultSizeEstimate) || 0,
    messages: messages.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      from: header(m, 'From'),
      to: header(m, 'To'),
      subject: header(m, 'Subject'),
      date: header(m, 'Date'),
      snippet: unescape(m.snippet),
      unread: (m.labelIds || []).includes('UNREAD'),
      starred: (m.labelIds || []).includes('STARRED'),
    })),
  }
}

/**
 * People to suggest in a To field, without the Contacts permission.
 *
 * Built from what the connection can already see: everyone you have written
 * to (Sent) or heard from (Inbox) recently. Cached per mailbox for ten
 * minutes - it costs a hundred small header reads to build, and a person
 * typing an address must not pay that per keystroke.
 */
const peopleCache = new Map()
const PEOPLE_TTL_MS = 10 * 60 * 1000

const parseAddresses = (value) =>
  String(value || '')
    .split(',')
    .map((part) => {
      const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) || part.match(/^\s*([^\s<>]+@[^\s<>]+)\s*$/)
      if (!m) return null
      const email = (m[2] || m[1]).trim().toLowerCase()
      const name = m[2] ? m[1].trim() : ''
      return email.includes('@') ? { name, email } : null
    })
    .filter(Boolean)

export async function recentPeople(member) {
  const key = member.gmail.address
  const cached = peopleCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.people
  const seen = new Map()
  const note = ({ name, email }) => {
    if (email === key) return
    const current = seen.get(email)
    if (!current) seen.set(email, { name, email })
    else if (!current.name && name) current.name = name
  }
  for (const [label, headers] of [
    ['SENT', ['To', 'Cc']],
    ['INBOX', ['From']],
  ]) {
    try {
      const list = await gmailFetch(member, `/messages?maxResults=60&labelIds=${label}`)
      const metas = await Promise.all(
        (list.messages || []).map((m) =>
          gmailFetch(member, `/messages/${m.id}?format=metadata&${headers.map((h) => `metadataHeaders=${h}`).join('&')}`),
        ),
      )
      for (const m of metas) for (const h of headers) parseAddresses(header(m, h)).forEach(note)
    } catch {
      // One folder failing must not empty the suggestions from the other.
    }
  }
  const people = [...seen.values()]
  peopleCache.set(key, { people, expires: Date.now() + PEOPLE_TTL_MS })
  return people
}

// Walk a MIME tree for the first text/plain part, falling back to text/html
// with the tags stripped. Enough to read a reply; not a mail client.
const bodyOf = (payload) => {
  const decode = (part) => Buffer.from(String(part.body?.data || ''), 'base64url').toString('utf8')
  const parts = []
  const walk = (part) => {
    if (!part) return
    if (part.parts?.length) part.parts.forEach(walk)
    else parts.push(part)
  }
  walk(payload)
  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data)
  if (plain) return decode(plain)
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data)
  if (html) {
    return decode(html)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  }
  return ''
}

/** One message in full, as text. */
export async function getMessage(member, id) {
  const m = await gmailFetch(member, `/messages/${encodeURIComponent(id)}?format=full`)
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, 'From'),
    to: header(m, 'To'),
    subject: header(m, 'Subject'),
    date: header(m, 'Date'),
    messageId: header(m, 'Message-ID'),
    references: header(m, 'References'),
    body: bodyOf(m.payload),
    unread: (m.labelIds || []).includes('UNREAD'),
  }
}

export const TEMPLATE_KEYS = ['voicemail-followup']

/** Every placeholder a template may use, and where each comes from. */
export const PLACEHOLDERS = [
  ['agency_name', 'The agency, e.g. Frankston Police Department'],
  ['chief_name', "The decision maker's full name, or blank"],
  ['chief_first_name', 'Their first name, or blank'],
  ['chief_title', 'Their title, e.g. Chief of Police'],
  ['greeting_name', 'First name if known, otherwise the agency name'],
  ['city', 'The agency city, when on file'],
  ['county', 'The county'],
  ['state', 'The state code, e.g. TX'],
  ['agency_phone', 'The agency phone number'],
  ['sender_name', 'The person sending, as named on the board'],
  ['sender_email', 'Their email address'],
]

/** Fill a template. Unknown placeholders are left as they are, so a typo shows. */
export function renderTemplate(template, agency, member) {
  const chief = String(agency.contacts?.chiefName || '').trim()
  const first = chief.split(/\s+/)[0] || ''
  const vars = {
    agency_name: agency.agencyName || '',
    chief_name: chief,
    chief_first_name: first,
    chief_title: agency.contacts?.chiefTitle || '',
    greeting_name: first || agency.agencyName || '',
    city: agency.city || agency.location?.city || '',
    county: agency.county || '',
    state: agency.state || '',
    agency_phone: agency.contacts?.phone || '',
    sender_name: member?.name || (member?.email || '').split('@')[0],
    sender_email: member?.gmail?.address || member?.email || '',
  }
  const fill = (text) => String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key) => (key in vars ? vars[key] : m))
  return { subject: fill(template.subject), body: fill(template.body) }
}

export const getTemplate = async (key) =>
  (await EmailTemplate.findOne({ key }).lean()) || { key, subject: '', body: '' }
