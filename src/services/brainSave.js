import { saveApprovedMemory } from './memoryGateway.js'

// Conversational "save this to the brain", routed through the governed writer.
//
// Why this exists: global rule 13 used to tell agents to call gbrain put_page
// themselves. On 2026-08-26 Brain reported `Saved ... Result: created_or_updated,
// and I verified it back in GBrain` for a page that was never written -- the slug
// returned page_not_found and the brain's page_count never moved. Nothing in that
// path could tell a real save from a described one, because the model both
// performed the action and reported on it.
//
// Now the agent only PROPOSES. It emits a block, the backend writes it through
// saveApprovedMemory (lifecycle stamp, sensitivity allowlist, secret screen), and
// the reply the user sees is rewritten from what the backend actually did.
export const SAVE_OPEN = '<save-to-brain>'
export const SAVE_CLOSE = '</save-to-brain>'

const BLOCK = /<save-to-brain>\s*([\s\S]*?)\s*<\/save-to-brain>/g

export const SAVE_TO_BRAIN_POLICY = [
  'Saving to the Brain: when the user tells you to save something -- "save this", "remember this" -- do NOT call put_page and do NOT claim you saved anything. Emit a save block and stop; the backend performs the write and appends the real result to your reply.',
  'Format, at the very END of your reply, nothing after it. Header lines, then a line of three dashes, then the body:',
  `${SAVE_OPEN}`,
  'title: phrase it as the question someone would later ask',
  'sensitivity: internal',
  '---',
  'The body. Write it as freely as you like: multiple lines, headings, lists,',
  'quotes and apostrophes are all fine. Nothing needs escaping.',
  SAVE_CLOSE,
  'PRESERVE THE SUBSTANCE. The body should contain what you would want to read back months from now -- the actual detail, examples and exact phrasings, not a one-line summary of them. If the user asked you to save an analysis, save the analysis, not a sentence describing that an analysis exists. A page is allowed to be long.',
  'CORRECTING SOMETHING ALREADY SAVED: to update a page instead of adding a second one, add a `replaces:` header line with the slug the backend reported. Two pages on the same subject leave retrieval with no way to tell which is current.',
  'One block per subject. Emit several blocks to save several things. Never emit a block unless the user asked you to save something, and never save raw conversation transcripts.',
  'Do not write a slug, do not say "saved", and do not report success or failure -- you cannot see the result. The backend appends the outcome, including the real slug or the real error.',
].join('\n')

// Pulls save blocks out of an assistant reply. Returns the reply with the blocks
// removed, plus whatever the agent proposed.
// Parses one block body. Two accepted shapes:
//
//   header lines, then `---`, then a free-form body   <- preferred
//   a JSON object                                     <- legacy
//
// The header/body form exists because JSON could not carry the content people
// actually save. A tone analysis with newlines, curly quotes and bullet points
// is not a valid JSON string unless every newline is escaped, and on 2026-08-26
// a real save was lost that way: the block failed to parse and nothing was
// written. Delimiters need no escaping, so the body can be as long and as
// punctuated as it likes.
function parseSaveBlock(body) {
  const raw = String(body || '').trim()
  if (!raw) return null

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      return {
        title: String(parsed?.title || '').trim(),
        content: String(parsed?.content || '').trim(),
        sensitivity: parsed?.sensitivity === 'public' ? 'public' : 'internal',
        replaces: String(parsed?.replaces || '').trim(),
      }
    } catch {
      return null
    }
  }

  const lines = raw.split('\n')
  const divider = lines.findIndex((line) => /^-{3,}\s*$/.test(line.trim()))
  // No divider: treat the first line as the title and the rest as the body, so
  // a slightly-off block still saves something rather than being discarded.
  const headerLines = divider === -1 ? lines.slice(0, 1) : lines.slice(0, divider)
  const bodyLines = divider === -1 ? lines.slice(1) : lines.slice(divider + 1)

  const headers = {}
  for (const line of headerLines) {
    const match = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.*)$/)
    if (match) headers[match[1].toLowerCase()] = match[2].trim()
  }

  const title = headers.title || headerLines[0]?.trim() || ''
  return {
    title: title.replace(/^title\s*:\s*/i, '').trim(),
    content: bodyLines.join('\n').trim(),
    sensitivity: headers.sensitivity === 'public' ? 'public' : 'internal',
    replaces: headers.replaces || '',
  }
}

// Pulls save blocks out of an assistant reply. Returns the reply with the blocks
// removed, plus whatever the agent proposed.
export function extractSaveRequests(content) {
  const text = String(content || '')
  const requests = []
  let cleaned = text.replace(BLOCK, (_match, body) => {
    const parsed = parseSaveBlock(body)
    if (parsed && parsed.title && parsed.content) {
      requests.push(parsed)
    } else {
      // Dropped from the reply and reported below, rather than shown to the
      // user as raw markup.
      requests.push({ malformed: true, title: parsed?.title || '' })
    }
    return ''
  })
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
  return { cleaned, requests }
}

// Writes each proposed page and returns a report built from what actually
// happened -- never from what the model said.
export async function applySaveRequests({ agentId, user, content }) {
  const { cleaned, requests } = extractSaveRequests(content)
  if (!requests.length) return { content: cleaned || content, saved: [], failed: [] }

  const saved = []
  const failed = []
  for (const request of requests) {
    if (request.malformed) {
      failed.push({
        title: request.title || 'unnamed',
        error: 'The save block was missing a title or a body, so nothing was written. Ask me to try again.',
      })
      continue
    }
    try {
      const memory = await saveApprovedMemory({
        agentId,
        user,
        proposal: {
          title: request.title,
          content: request.content,
          department: 'shared',
          sensitivity: request.sensitivity,
          // One brain: readable by every agent.
          allowedAgents: [],
          ...(request.replaces ? { targetSlug: request.replaces } : {}),
        },
        confirmed: true,
      })
      saved.push({ ...memory, replaced: Boolean(request.replaces) })
    } catch (error) {
      failed.push({ title: request.title, error: error?.message || String(error) })
    }
  }

  const lines = []
  for (const memory of saved) {
    const verb = memory.replaced ? 'Updated' : 'Saved'
    lines.push(`${verb} **${memory.title}** ${memory.replaced ? 'at' : 'to'} \`${memory.slug}\`${memory.verified ? ' (read back and verified)' : ''}.`)
  }
  for (const failure of failed) {
    lines.push(`Could not save **${failure.title}**: ${failure.error}`)
  }

  return {
    content: [cleaned, lines.join('\n')].filter(Boolean).join('\n\n'),
    saved,
    failed,
  }
}

// Streaming: hold back everything from the opening marker onward so the user
// never sees the raw block. Same shape as createSentinelGate.
export function createSaveGate(write) {
  let held = ''
  let holding = false
  return {
    emit(delta) {
      if (holding) { held += delta; return }
      const combined = held + delta
      const index = combined.indexOf(SAVE_OPEN)
      if (index !== -1) {
        holding = true
        held = combined.slice(index)
        const visible = combined.slice(0, index)
        if (visible) write(visible)
        return
      }
      // Keep back just enough to recognise a marker split across deltas.
      const keep = SAVE_OPEN.length - 1
      if (combined.length > keep) {
        write(combined.slice(0, combined.length - keep))
        held = combined.slice(combined.length - keep)
      } else {
        held = combined
      }
    },
    // Anything still held that never became a save block is real text.
    flush() {
      if (holding || !held) return
      const pending = held
      held = ''
      write(pending)
    },
  }
}
