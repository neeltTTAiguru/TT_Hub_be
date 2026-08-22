import crypto from 'node:crypto'
import EmailAsset from '../models/EmailAsset.js'

const DATA_URI_PATTERN = /src\s*=\s*"data:(image\/[a-zA-Z0-9.+-]+);base64,([^"]+)"/g
const MAX_BYTES = 2 * 1024 * 1024

// Brevo's own image gallery only ingests remote URLs, so it cannot take these
// directly. Store each distinct image once (keyed by hash) and hand back an
// absolute URL the recipient's mail client can fetch.
async function storeImage(mimeType, base64) {
  const data = Buffer.from(base64, 'base64')
  if (data.length > MAX_BYTES) {
    const error = new Error('An image in this email is larger than 2MB. Resize it and try again.')
    error.statusCode = 413
    throw error
  }

  const sha256 = crypto.createHash('sha256').update(data).digest('hex')
  const existing = await EmailAsset.findOne({ sha256 }).select('_id')
  if (existing) return existing._id.toString()

  const created = await EmailAsset.create({
    sha256,
    mimeType,
    sizeBytes: data.length,
    data,
  })
  return created._id.toString()
}

export function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_API_BASE_URL?.trim().replace(/\/$/, '')
  if (configured) return configured
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https'
  return `${proto}://${req.get('host')}`
}

export async function hostInlineImages(html, baseUrl) {
  const matches = [...html.matchAll(DATA_URI_PATTERN)]
  if (!matches.length) return html

  let result = html
  for (const [full, mimeType, base64] of matches) {
    const id = await storeImage(mimeType, base64)
    result = result.replace(full, `src="${baseUrl}/email-assets/${id}"`)
  }
  return result
}
