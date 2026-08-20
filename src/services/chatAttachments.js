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

// Vision only accepts these. HEIC/HEIF and friends must be reported, not sent.
const VISION_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

// A browser hands us whatever MIME the OS declared, which for a dragged file is
// often empty or `application/octet-stream`. Trusting it verbatim sent photos
// down the document path, where they extracted to nothing and vanished — the
// model then answered from context alone. Recover the real type from the bytes.
function sniffMimeFromBytes(buffer) {
  if (buffer.length < 12) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  // ISO base media container: `ftyp` at offset 4, brand tells HEIC from MP4.
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1')
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/i.test(brand)) return 'image/heic'
  }
  return ''
}

const EXTENSION_MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heic',
  pdf: 'application/pdf',
}

function effectiveMimeType(attachment, buffer) {
  const declared = String(attachment?.mimeType || '').toLowerCase()
  const sniffed = sniffMimeFromBytes(buffer)
  if (sniffed) return sniffed
  if (declared && declared !== 'application/octet-stream') return declared
  const extension = String(attachment?.name || '').split('.').pop()?.toLowerCase() || ''
  return EXTENSION_MIME_TYPES[extension] || declared || 'application/octet-stream'
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
  if (!atts.length) return { content: userText, meta: { docs: 0, images: 0, unreadable: [] } }

  // Resolve every attachment's real type from its bytes before routing it, so a
  // mislabelled photo still reaches vision instead of dying in the doc path.
  const resolved = atts.map((attachment) => {
    const buffer = decodeBase64(attachment?.dataBase64)
    return { ...attachment, buffer, mimeType: effectiveMimeType(attachment, buffer) }
  })

  const images = resolved.filter((a) => VISION_MIME_TYPES.has(a.mimeType)).slice(0, MAX_IMAGES)
  const docs = resolved.filter((a) => !VISION_MIME_TYPES.has(a.mimeType))

  const blocks = []
  const unreadable = []
  for (const doc of docs) {
    const text = await extractAttachmentText(doc)
    if (text) blocks.push(`--- Attached file: ${doc.name || 'file'} ---\n${text}`)
    else {
      unreadable.push({
        name: doc.name || 'file',
        // HEIC is the common case: an iPhone photo no vision model accepts.
        reason: isImageMime(doc.mimeType)
          ? `image format ${doc.mimeType} is not supported (convert to JPEG or PNG)`
          : 'unsupported file type',
      })
    }
  }
  const docText = blocks.join('\n\n').slice(0, MAX_DOC_TEXT_CHARS)

  let combinedText = userText || ''
  if (docText) {
    combinedText = `${combinedText}\n\nThe user attached the following file(s); use their contents to answer:\n\n${docText}`.trim()
  }
  // Without this the model answers from surrounding context and invents a
  // confident description of a file it never received.
  if (unreadable.length) {
    const list = unreadable.map((entry) => `${entry.name} (${entry.reason})`).join(', ')
    combinedText = `${combinedText}\n\nSYSTEM NOTE: the user attached ${list}. You did NOT receive this content. Tell the user you could not read it and why — do not describe or guess at its contents.`.trim()
  }

  if (!images.length) {
    return { content: combinedText, meta: { docs: blocks.length, images: 0, unreadable } }
  }

  const parts = [{ type: 'text', text: combinedText || 'Please analyze the attached image(s).' }]
  for (const img of images) {
    // Re-encode from the decoded bytes so the data URI always carries the
    // resolved MIME type, not whatever the browser mislabelled it as.
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.buffer.toString('base64')}` },
    })
  }
  return { content: parts, meta: { docs: blocks.length, images: images.length, unreadable } }
}
