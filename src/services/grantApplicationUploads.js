import { PDFParse } from 'pdf-parse'

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const MAX_TEXT_CHARS = 40000

export function normalizeUploadedGrantText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function getUploadKind(fileName, contentType) {
  const lowerName = String(fileName || '').toLowerCase()
  const lowerType = String(contentType || '').toLowerCase()

  if (lowerType.includes('pdf') || lowerName.endsWith('.pdf')) {
    return 'pdf'
  }

  if (
    lowerType.includes('text') ||
    lowerType.includes('json') ||
    lowerName.endsWith('.txt') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.csv')
  ) {
    return 'text'
  }

  return 'unsupported'
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer })

  try {
    const result = await parser.getText()
    return normalizeUploadedGrantText(result.text)
  } finally {
    await parser.destroy()
  }
}

export async function extractGrantApplicationUpload({ buffer, fileName, contentType }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new Error('Upload a grant application file.')
    error.statusCode = 400
    throw error
  }

  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    const error = new Error('Grant application uploads must be 10 MB or smaller.')
    error.statusCode = 413
    throw error
  }

  const uploadKind = getUploadKind(fileName, contentType)

  if (uploadKind === 'unsupported') {
    const error = new Error('Only PDF and text grant application uploads are supported right now.')
    error.statusCode = 415
    throw error
  }

  const extractedText = uploadKind === 'pdf'
    ? await parsePdf(buffer)
    : normalizeUploadedGrantText(buffer.toString('utf8'))

  if (!extractedText) {
    const error = new Error('Could not extract readable text from this grant application.')
    error.statusCode = 422
    throw error
  }

  return {
    extractedText: extractedText.slice(0, MAX_TEXT_CHARS),
    truncated: extractedText.length > MAX_TEXT_CHARS,
    sizeBytes: buffer.byteLength,
  }
}
