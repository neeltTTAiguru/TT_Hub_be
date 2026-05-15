import { PDFParse } from 'pdf-parse'
import Opportunity from '../models/Opportunity.js'

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_TEXT_CHARS = 30000
const FETCH_TIMEOUT_MS = 30000

function assertPublicHttpUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    const error = new Error('Attachment URL is invalid.')
    error.statusCode = 400
    throw error
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('Only public HTTP(S) attachment URLs can be read.')
    error.statusCode = 400
    throw error
  }

  return parsed.toString()
}

function getContentLength(headers) {
  const raw = headers.get('content-length')
  const parsed = raw ? Number.parseInt(raw, 10) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function getAttachmentType(attachment, contentType) {
  const label = String(attachment.label || attachment.url || '').toLowerCase()
  const type = String(attachment.fileType || contentType || '').toLowerCase()

  if (type.includes('pdf') || label.includes('.pdf')) {
    return 'pdf'
  }

  if (type.includes('text') || label.endsWith('.txt') || label.endsWith('.csv')) {
    return 'text'
  }

  return 'unsupported'
}

async function fetchAttachmentBuffer(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/pdf,text/plain,*/*',
        'User-Agent': 'TrustedTechOpenClaw/1.0',
      },
    })

    if (!response.ok) {
      const error = new Error(`Attachment request failed with ${response.status}.`)
      error.statusCode = response.status
      throw error
    }

    const contentLength = getContentLength(response.headers)
    if (contentLength > MAX_ATTACHMENT_BYTES) {
      const error = new Error(`Attachment is too large to read locally (${contentLength} bytes).`)
      error.statusCode = 413
      throw error
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) {
      const error = new Error(`Attachment is too large to read locally (${arrayBuffer.byteLength} bytes).`)
      error.statusCode = 413
      throw error
    }

    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || '',
      sizeBytes: arrayBuffer.byteLength,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    return normalizeText(result.text)
  } finally {
    await parser.destroy()
  }
}

async function readAttachment(attachment) {
  const url = assertPublicHttpUrl(attachment.url)
  const fetched = await fetchAttachmentBuffer(url)
  const attachmentType = getAttachmentType(attachment, fetched.contentType)

  if (attachmentType === 'unsupported') {
    return {
      ...attachment,
      url,
      status: 'unsupported',
      contentType: fetched.contentType,
      sizeBytes: fetched.sizeBytes,
      text: '',
      excerpt: '',
      error: 'Only public PDFs and text attachments are supported right now.',
    }
  }

  const text =
    attachmentType === 'pdf'
      ? await parsePdf(fetched.buffer)
      : normalizeText(fetched.buffer.toString('utf8'))
  const clippedText = text.slice(0, MAX_TEXT_CHARS)

  return {
    ...attachment,
    url,
    status: clippedText ? 'read' : 'empty',
    contentType: fetched.contentType,
    sizeBytes: fetched.sizeBytes,
    text: clippedText,
    excerpt: clippedText.slice(0, 4000),
    truncated: text.length > MAX_TEXT_CHARS,
  }
}

export async function readOpportunityAttachments(noticeId) {
  const opportunity = await Opportunity.findOne({ noticeId })
  if (!opportunity) {
    const error = new Error('Opportunity not found.')
    error.statusCode = 404
    throw error
  }

  const attachmentLinks = Array.isArray(opportunity.attachmentLinks) ? opportunity.attachmentLinks : []
  const publicLinks = attachmentLinks.filter((attachment) => String(attachment.access || 'public').toLowerCase() === 'public')

  const attachments = await Promise.all(
    publicLinks.map(async (attachment) => {
      try {
        return await readAttachment(attachment.toObject ? attachment.toObject() : attachment)
      } catch (error) {
        return {
          label: attachment.label || 'SAM.gov attachment',
          url: attachment.url || '',
          access: attachment.access || 'public',
          fileType: attachment.fileType || '',
          status: 'error',
          text: '',
          excerpt: '',
          error: error instanceof Error ? error.message : 'Attachment could not be read.',
        }
      }
    }),
  )

  return {
    opportunity,
    attachments,
  }
}
