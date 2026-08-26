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
  `Format, at the very END of your reply, nothing after it: ${SAVE_OPEN}{"title":"...","content":"...","sensitivity":"internal"}${SAVE_CLOSE}`,
  'CORRECTING SOMETHING ALREADY SAVED: if the user is updating, correcting or superseding a fact you saved earlier in this conversation, add "replaces":"<the slug the backend reported>" to the block. The backend then overwrites that page instead of creating a second one. Without it you leave two contradicting pages in the brain, and retrieval has no way to tell which is current.',
  'title: phrase it as the question someone would later ask. content: one self-contained fact, readable with no surrounding context. sensitivity: "internal" unless the user says it is public.',
  'One block per fact. Emit several blocks to save several facts. Never emit a block unless the user asked you to save something, and never save raw conversation transcripts.',
  'Do not write a slug, do not say "saved", and do not report success or failure -- you cannot see the result. The backend appends the outcome, including the real slug or the real error.',
].join('\n')

// Pulls save blocks out of an assistant reply. Returns the reply with the blocks
// removed, plus whatever the agent proposed.
export function extractSaveRequests(content) {
  const text = String(content || '')
  const requests = []
  let cleaned = text.replace(BLOCK, (_match, body) => {
    try {
      const parsed = JSON.parse(String(body).trim())
      const title = String(parsed?.title || '').trim()
      const value = String(parsed?.content || '').trim()
      if (title && value) {
        requests.push({
          title,
          content: value,
          sensitivity: parsed?.sensitivity === 'public' ? 'public' : 'internal',
          // Set when the agent is correcting a page it saved earlier in this
          // conversation: the write overwrites that slug rather than adding a
          // second, contradicting page.
          replaces: String(parsed?.replaces || '').trim(),
        })
      }
    } catch {
      // A malformed block is dropped from the reply and reported below, rather
      // than shown to the user as raw JSON.
      requests.push({ malformed: true })
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
      failed.push({ title: 'unnamed', error: 'The save block was not valid JSON, so nothing was written.' })
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
