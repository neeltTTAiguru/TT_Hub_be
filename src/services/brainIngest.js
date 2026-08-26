import KnowledgeDocument from '../models/KnowledgeDocument.js'
import { saveDocumentSectionMemory } from './memoryGateway.js'
import { chatWithHermes } from './hermesChat.js'
import { chatWithOpenAIInstructions } from './openaiChat.js'

// Turns an uploaded company document into brain pages.
//
// Why split at all: retrieval returns whole pages and an agent only gets a
// handful per answer, so one 40-page RFP stored as a single page loses every
// search — it is not strongly "about" any one thing, and its body would be
// truncated anyway. Split into single-topic pages, each titled like the question
// someone would ask, and each can win its own search.
const MAX_SECTIONS = Number(process.env.BRAIN_INGEST_MAX_SECTIONS || 40)
const MAX_SOURCE_CHARS = Number(process.env.BRAIN_INGEST_MAX_CHARS || 120000)
const MAX_SECTION_CHARS = 3500

const SPLIT_INSTRUCTIONS = `You split Trusted Technology company documents into knowledge-base pages.

Return ONLY valid JSON, no prose, in this exact shape:
{"sections":[{"title":"","content":""}]}

Rules:
- One topic per section. Never combine two subjects into one page.
- Title each section as the QUESTION SOMEONE WOULD ASK, phrased as a statement.
  Good: "T500 warranty terms offered to agencies". Bad: "Section 4.2", "Overview".
- content must be self-contained prose. It will be read on its own, with no
  surrounding document, so never write "as described above" or "see section 3".
- Preserve concrete facts exactly: numbers, durations, certifications, terms,
  prices. Never round, never summarise a figure away, never invent one.
- Omit boilerplate: title pages, tables of contents, page numbers, signature
  blocks, legal footers, repeated headers.
- If a passage states how Trusted Technology describes a product or answers an
  objection, keep that phrasing verbatim — the wording is the value.
- Return at most ${MAX_SECTIONS} sections. Prefer fewer, denser pages over many
  thin ones.
- Each content field must stay under ${MAX_SECTION_CHARS} characters.`

function extractJson(text) {
  const raw = String(text || '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : raw).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('The splitter did not return JSON.')
  return JSON.parse(candidate.slice(start, end + 1))
}

// Hermes first (the house runtime), OpenAI as the fallback — the same pattern
// wordpressDraftEditor uses, so an offline gateway does not block an upload.
async function splitDocument(title, text, signal) {
  const prompt = `Document title: ${title}\n\nDocument text:\n${text.slice(0, MAX_SOURCE_CHARS)}`
  const messages = [{ role: 'user', content: prompt }]
  let content
  try {
    const response = await chatWithHermes('trusted-tech-assistant', messages, {
      instructions: SPLIT_INSTRUCTIONS,
      // Deliberately no memoryContext: splitting is a mechanical read of THIS
      // document. Prior memory would only tempt the model to blend in facts that
      // are not in the file.
      memoryContext: '',
      timeoutMs: 180000,
      signal,
    })
    content = response.message.content
  } catch {
    content = (await chatWithOpenAIInstructions(messages, SPLIT_INSTRUCTIONS)).message.content
  }
  const parsed = extractJson(content)
  const sections = Array.isArray(parsed?.sections) ? parsed.sections : []
  return sections
    .map((section) => ({
      title: String(section?.title || '').trim(),
      content: String(section?.content || '').trim().slice(0, MAX_SECTION_CHARS),
    }))
    .filter((section) => section.title.length >= 3 && section.content.length >= 10)
    .slice(0, MAX_SECTIONS)
}

export async function ingestDocumentToBrain({ documentId, sensitivity = 'internal', signal } = {}) {
  const document = await KnowledgeDocument.findById(documentId).lean()
  if (!document) throw Object.assign(new Error('That document was not found.'), { statusCode: 404 })

  const text = String(document.extractedText || '').trim()
  if (text.length < 50) {
    throw Object.assign(
      new Error('No readable text was extracted from that file, so there is nothing to ingest.'),
      { statusCode: 400 },
    )
  }

  const sections = await splitDocument(document.title, text, signal)
  if (!sections.length) {
    throw Object.assign(new Error('The document could not be split into pages.'), { statusCode: 422 })
  }

  const written = []
  const skipped = []
  for (const section of sections) {
    try {
      const page = await saveDocumentSectionMemory({
        documentId: String(document._id),
        documentTitle: document.title,
        section: section.title,
        content: section.content,
        sensitivity,
      })
      written.push(page)
    } catch (error) {
      // One bad section (a credential-looking line, a too-short body) must not
      // lose the other thirty-nine.
      skipped.push({ title: section.title, reason: error?.message || String(error) })
    }
  }

  await KnowledgeDocument.updateOne(
    { _id: document._id },
    { $set: { brainPageCount: written.length, brainIngestedAt: new Date() } },
  )

  console.log(JSON.stringify({
    event: 'brain_document_ingested',
    documentId: String(document._id),
    title: document.title,
    written: written.length,
    skipped: skipped.length,
  }))

  return { documentId: String(document._id), title: document.title, written, skipped }
}
