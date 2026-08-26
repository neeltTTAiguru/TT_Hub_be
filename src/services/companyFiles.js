import crypto from 'node:crypto'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import KnowledgeDocument from '../models/KnowledgeDocument.js'
import KnowledgeRecord from '../models/KnowledgeRecord.js'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

// The browser's reported type is a hint, not a guarantee, and it is absent
// entirely if the header is stripped in transit. The extension decides.
function mimeFor(fileName, contentType) {
  const name = String(fileName || '').toLowerCase()
  if (name.endsWith('.pdf')) return 'application/pdf'
  if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (name.endsWith('.doc')) return 'application/msword'
  if (name.endsWith('.md')) return 'text/markdown'
  if (name.endsWith('.txt')) return 'text/plain'
  return String(contentType || 'application/octet-stream')
}

function kindOf(fileName, contentType) {
  const name = String(fileName || '').toLowerCase()
  const type = String(contentType || '').toLowerCase()
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf'
  if (name.endsWith('.docx') || type.includes('wordprocessingml')) return 'docx'
  if (name.endsWith('.doc')) return 'docx'
  if (type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) return 'text'
  return 'unsupported'
}

function tidy(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Extracts readable text so the document can reach an agent's prompt. The
// original bytes are kept alongside it, so a re-read is always possible without
// asking the user to upload again.
export async function extractCompanyFile({ buffer, fileName, contentType }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error('The upload was empty.'), { statusCode: 400 })
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error('Files must be 25 MB or smaller.'), { statusCode: 413 })
  }

  const kind = kindOf(fileName, contentType)
  if (kind === 'unsupported') {
    throw Object.assign(
      new Error('Upload a PDF, Word (.docx) or text file.'),
      { statusCode: 415 },
    )
  }

  let text = ''
  let pageCount = 0
  if (kind === 'pdf') {
    const parsed = await new PDFParse({ data: buffer }).getText()
    text = tidy(parsed.text)
    pageCount = parsed.pages?.length || parsed.numpages || 0
  } else if (kind === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer })
    text = tidy(value)
  } else {
    text = tidy(buffer.toString('utf8'))
  }

  if (text.length < 40) {
    throw Object.assign(
      new Error('No readable text was found. A scanned document needs OCR before upload.'),
      { statusCode: 422 },
    )
  }
  return { text, pageCount, kind }
}

// Re-uploading the same file updates it in place rather than creating a second
// copy — sha256 is unique on the model, so a plain create would throw.
export async function saveCompanyFile({ buffer, fileName, contentType, title, user }) {
  const { text, pageCount } = await extractCompanyFile({ buffer, fileName, contentType })
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  const cleanTitle = String(title || fileName || 'Company file').trim().slice(0, 200)

  const existing = await KnowledgeDocument.findOne({ sha256 })
  if (existing) {
    existing.title = cleanTitle
    existing.originalFilename = fileName
    existing.extractedText = text
    existing.pageCount = pageCount
    existing.fileData = buffer
    await existing.save()
    return { document: existing, replaced: true }
  }

  const document = await KnowledgeDocument.create({
    title: cleanTitle,
    originalFilename: fileName,
    mimeType: mimeFor(fileName, contentType),
    sizeBytes: buffer.length,
    sha256,
    sourceType: 'company_file',
    visibility: 'internal',
    approvalStatus: 'pending',
    extractedText: text,
    fileData: buffer,
    pageCount,
  })
  return { document, replaced: false }
}

export async function listCompanyFiles() {
  const documents = await KnowledgeDocument.find({}, { fileData: 0, extractedText: 0 })
    .sort({ createdAt: -1 })
    .lean()
  const counts = await KnowledgeRecord.aggregate([
    { $group: { _id: '$sourceDocument', count: { $sum: 1 } } },
  ])
  const byDocument = new Map(counts.map((row) => [String(row._id), row.count]))
  return documents.map((document) => ({
    id: String(document._id),
    title: document.title,
    originalFilename: document.originalFilename,
    sizeBytes: document.sizeBytes,
    pageCount: document.pageCount,
    sourceType: document.sourceType,
    approvalStatus: document.approvalStatus,
    recordCount: byDocument.get(String(document._id)) || 0,
    brainPageCount: document.brainPageCount || 0,
    brainIngestedAt: document.brainIngestedAt || null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }))
}

// Deleting a document takes its derived records with it. Leaving them behind
// would keep feeding an agent claims whose source the user believes is gone.
export async function deleteCompanyFile(id) {
  const document = await KnowledgeDocument.findById(id)
  if (!document) throw Object.assign(new Error('That file no longer exists.'), { statusCode: 404 })
  const { deletedCount } = await KnowledgeRecord.deleteMany({ sourceDocument: document._id })
  await document.deleteOne()
  return { deletedRecords: deletedCount || 0 }
}
