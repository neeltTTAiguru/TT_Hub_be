import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import mongoose from 'mongoose'
import mammoth from 'mammoth'
import KnowledgeDocument from '../src/models/KnowledgeDocument.js'
import KnowledgeRecord from '../src/models/KnowledgeRecord.js'

const sourcePath = process.argv[2]
if (!sourcePath) {
  throw new Error('Usage: node scripts/importRfpBaseline.js /absolute/path/to/baseline-rfp.docx')
}

const approvedAt = new Date()
const approvedBy = 'Neel Palle (user import)'

function decodeHtml(value) {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

function htmlToText(html) {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|tr|table|ul|ol|blockquote)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').replace(/\s+\|\s*$/, '').trim())
    .filter(Boolean)
    .join('\n')
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90)
}

function extractSections(html) {
  const headings = [...html.matchAll(/<h([1-6])>([\s\S]*?)<\/h\1>/gi)]
  const hierarchy = []
  const sections = []

  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index]
    const level = Number(match[1])
    const title = htmlToText(match[2])
    const start = match.index + match[0].length
    const end = headings[index + 1]?.index ?? html.length
    const content = htmlToText(html.slice(start, end))

    hierarchy[level - 1] = title
    hierarchy.length = level
    if (!title || !content) continue

    const headingPath = hierarchy.filter(Boolean)
    sections.push({
      key: `${String(index + 1).padStart(3, '0')}-${slugify(headingPath.join(' '))}`,
      title,
      content,
      tags: ['rfp', 'baseline', 'canonical', ...headingPath.map(slugify)].filter(Boolean),
      notes: `Canonical heading path: ${headingPath.join(' > ')}`,
    })
  }

  return sections
}

const buffer = await fs.readFile(sourcePath)
const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
const [{ value: html }, { value: rawText }] = await Promise.all([
  mammoth.convertToHtml({ buffer }),
  mammoth.extractRawText({ buffer }),
])
const sections = extractSections(html)

if (!rawText.trim()) throw new Error('No text could be extracted from the DOCX file.')
if (!sections.length) throw new Error('No headed sections could be extracted from the DOCX file.')

await mongoose.connect(process.env.MONGODB_URI)
try {
  const document = await KnowledgeDocument.findOneAndUpdate(
    { sha256 },
    {
      title: 'TTSI Baseline RFP Specification',
      originalFilename: path.basename(sourcePath),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: buffer.length,
      sha256,
      sourceType: 'internal_rfp_baseline',
      visibility: 'internal',
      approvalStatus: 'approved',
      products: ['T500', 'T500 Docking Station', 'Trusted Vault'],
      extractedText: rawText.trim(),
      fileData: buffer,
      pageCount: 0,
      approvedAt,
      approvedBy,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )

  const retainedKeys = []
  for (const section of sections) {
    retainedKeys.push(section.key)
    await KnowledgeRecord.findOneAndUpdate(
      { sourceDocument: document._id, key: section.key },
      {
        sourceDocument: document._id,
        key: section.key,
        category: 'rfp-baseline',
        title: section.title,
        content: section.content,
        sourcePages: [],
        products: ['T500', 'T500 Docking Station', 'Trusted Vault'],
        tags: section.tags,
        visibility: 'internal',
        verificationStatus: 'approved',
        contentUse: 'internal_only',
        notes: `${section.notes}. Internal canonical proposal guidance; do not publish or disclose without authorization.`,
        approvedAt,
        approvedBy,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
  }

  const removed = await KnowledgeRecord.deleteMany({
    sourceDocument: document._id,
    key: { $nin: retainedKeys },
  })

  console.log(JSON.stringify({
    documentId: document._id,
    sha256,
    title: document.title,
    extractedCharacters: rawText.trim().length,
    records: sections.length,
    staleRecordsRemoved: removed.deletedCount,
    visibility: document.visibility,
    contentUse: 'internal_only',
  }))
} finally {
  await mongoose.disconnect()
}
