const BREVO_API_BASE = 'https://api.brevo.com/v3'

function requireApiKey() {
  const key = process.env.BREVO_API_KEY?.trim()
  if (!key) {
    const error = new Error('BREVO_API_KEY is not configured on the server')
    error.statusCode = 503
    throw error
  }
  return key
}

async function brevoFetch(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BREVO_API_BASE}${path}`, {
    method,
    headers: {
      'api-key': requireApiKey(),
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

  const raw = await response.text()
  let parsed = null
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { message: raw }
    }
  }

  if (!response.ok) {
    const error = new Error(parsed?.message || `Brevo request failed (${response.status})`)
    error.statusCode = response.status === 401 ? 502 : response.status
    throw error
  }

  return parsed
}

// Brevo returns `totalSubscribers: 0` for every list regardless of size; the
// real figure lives in `uniqueSubscribers`. Normalise it here so no caller has
// to remember which field is the honest one.
export async function listContactLists() {
  const data = await brevoFetch('/contacts/lists?limit=50&offset=0')
  return (data?.lists || []).map((list) => ({
    id: list.id,
    name: list.name,
    folderId: list.folderId,
    contactCount: list.uniqueSubscribers ?? 0,
  }))
}

export async function listSenders() {
  const data = await brevoFetch('/senders')
  return (data?.senders || []).map((sender) => ({
    id: sender.id,
    name: sender.name,
    email: sender.email,
    active: sender.active !== false,
  }))
}

export async function createCampaign({ name, subject, senderName, senderEmail, htmlContent, listIds }) {
  return brevoFetch('/emailCampaigns', {
    method: 'POST',
    body: {
      name,
      subject,
      sender: { name: senderName, email: senderEmail },
      htmlContent,
      recipients: { listIds },
      inlineImageActivation: false,
    },
  })
}

export async function sendTestEmail(campaignId, emails) {
  return brevoFetch(`/emailCampaigns/${campaignId}/sendTest`, {
    method: 'POST',
    body: { emailTo: emails },
  })
}

export async function sendCampaignNow(campaignId) {
  return brevoFetch(`/emailCampaigns/${campaignId}/sendNow`, { method: 'POST' })
}
