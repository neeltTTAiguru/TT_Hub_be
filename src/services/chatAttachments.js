// Turns chat attachments into something the model can use:
//   - PDFs / Word / text  -> extracted text, appended to the user's message
//   - images              -> OpenAI chat-completions multimodal image parts
// Documents work on every chat path (they're just text). Images require a
// vision-capable model on the other side (Hermes -> gpt-5.4-mini).

import { PDFParse } from 'pdf-parse'
import mammoth from 'mammoth'

const MAX_DOC_TEXT_CHARS = Number(process.env.CHAT_ATTACHMENT_MAX_TEXT_CHARS || 20000)
const MAX_IMAGES = Number(process.env.CHAT_ATTACHMENT_MAX_IMAGES || 4)
const MAX_ATTACHMENTS = Number(process.env.CHAT_ATTACHMENT_MAX_COUNT || 8)

function decodeBase64(value) {
  const raw = String(value || '')
  // Accept a bare base64 string or a full `data:<mime>;base64,<data>` URI.
  const b64 = raw.startsWith('data:') && raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  try {
    return Buffer.from(b64, 'base64')
  } catch {
    return Buffer.alloc(0)
  }
}

function isImageMime(mime) {
  return /^image\//i.test(String(mime || ''))
}

function isPdf(name, mime) {
  return /\.pdf$/i.test(String(name || '')) || /application\/pdf/i.test(String(mime || ''))
}

function isDocx(name, mime) {
  return /\.docx$/i.test(String(name || '')) || /wordprocessing/i.test(String(mime || ''))
}

function isPlainText(name, mime) {
  return /\.(txt|md|markdown|csv|tsv|json|log|ya?ml)$/i.test(String(name || '')) || /^text\//i.test(String(mime || ''))
}

async function extractPdf(buffer) {
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    return String(result.text || '').trim()
  } finally {
    await parser.destroy()
  }
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer })
  return String(result.value || '').trim()
}

// Extract readable text from one non-image attachment. Returns '' if unsupported.
export async function extractAttachmentText(attachment) {
  const buffer = decodeBase64(attachment?.dataBase64)
  if (!buffer.length) return ''
  const { name, mimeType } = attachment || {}
  try {
    if (isPdf(name, mimeType)) return await extractPdf(buffer)
    if (isDocx(name, mimeType)) return await extractDocx(buffer)
    if (isPlainText(name, mimeType)) return buffer.toString('utf8').trim()
  } catch (error) {
    return `(could not read ${name || 'file'}: ${error?.message || 'unreadable'})`
  }
  return ''
}

// Build the content for the latest user message given its attachments.
// Returns { content, meta }. `content` is a plain string when there are no
// images (docs-only or none), or a chat-completions multimodal array when
// images are present.
export async function buildUserContentWithAttachments(userText, attachments = []) {
  const atts = (Array.isArray(attachments) ? attachments : []).slice(0, MAX_ATTACHMENTS)
  if (!atts.length) return { content: userText, meta: { docs: 0, images: 0 } }

  const images = atts.filter((a) => isImageMime(a?.mimeType)).slice(0, MAX_IMAGES)
  const docs = atts.filter((a) => !isImageMime(a?.mimeType))

  const blocks = []
  for (const doc of docs) {
    const text = await extractAttachmentText(doc)
    if (text) blocks.push(`--- Attached file: ${doc.name || 'file'} ---\n${text}`)
  }
  const docText = blocks.join('\n\n').slice(0, MAX_DOC_TEXT_CHARS)

  let combinedText = userText || ''
  if (docText) {
    combinedText = `${combinedText}\n\nThe user attached the following file(s); use their contents to answer:\n\n${docText}`.trim()
  }

  if (!images.length) {
    return { content: combinedText, meta: { docs: blocks.length, images: 0 } }
  }

  const parts = [{ type: 'text', text: combinedText || 'Please analyze the attached image(s).' }]
  for (const img of images) {
    const raw = String(img.dataBase64 || '')
    const url = raw.startsWith('data:') ? raw : `data:${img.mimeType || 'image/png'};base64,${raw}`
    parts.push({ type: 'image_url', image_url: { url } })
  }
  return { content: parts, meta: { docs: blocks.length, images: images.length } }
}
