import { marked, Renderer } from 'marked'

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// Signals that a Markdown block is an internal image/production directive the
// article writer leaked into prose. Any one match removes the block. These are
// phrasing-independent: they key on tokens that never appear in real article
// copy (asset paths, brief-enum source values, structured Role:/aspectRatio
// fields, and "image placement/note" directives).
const PRODUCTION_NOTE_SIGNALS = [
  /assets\/article-images\//i,
  /\bsource:\s*(?:approved_t500_reference|approved_media|generated_conceptual)\b/i,
  /\brole:\s*(?:featured|inline)\b/i,
  /\b(?:featured|inline|hero|supporting)\s+image\s+(?:placement|note)\b/i,
  /\bimage\s+(?:placement|note)\s*[:,-]/i,
  /\baspect\s*ratio\s*:/i,
  /\balt\s*text\s*:/i,
  /\bdo not redesign the (?:device|camera)\b/i,
]

// Remove any paragraph-level block that is an internal image/production note.
// Operates on Markdown blocks (split on blank lines) so a leaked note is dropped
// whole, regardless of how the writer phrased or emphasised it.
export function stripProductionNotes(markdown) {
  return String(markdown || '')
    .split(/\n{2,}/)
    .filter((block) => {
      const text = block.replace(/[*_`>]/g, '').trim()
      if (!text) return true
      return !PRODUCTION_NOTE_SIGNALS.some((re) => re.test(text))
    })
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeHeading(value) {
  return String(value || '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function removeDuplicateTitle(markdown, title) {
  const match = String(markdown || '').match(/^\s*#\s+([^\n]+)\n+/)
  if (!match || normalizeHeading(match[1]) !== normalizeHeading(title)) return String(markdown || '')
  return String(markdown).slice(match[0].length)
}

function slugifyHeading(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function formatResourceArticle(html, title) {
  const usedIds = new Map()
  let styled = String(html).replace(/<h([23])>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => {
    const headingText = content.replace(/<[^>]+>/g, '').trim()
    const base = slugifyHeading(headingText) || `section-${usedIds.size + 1}`
    const count = usedIds.get(base) || 0
    usedIds.set(base, count + 1)
    const id = count ? `${base}-${count + 1}` : base
    const style = level === '2'
      ? 'font-family:Ubuntu,Arial,sans-serif!important;font-size:clamp(1.65rem,3vw,2.35rem)!important;line-height:1.2!important;margin:3rem 0 1rem;color:#37372f;scroll-margin-top:7rem;'
      : 'font-family:Ubuntu,Arial,sans-serif!important;font-size:clamp(1.25rem,2vw,1.6rem)!important;line-height:1.3!important;margin:2rem 0 .75rem;color:#4a4941;scroll-margin-top:7rem;'
    return `<h${level} id="${id}" style="${style}">${content}</h${level}>`
  })

  const introMatch = styled.match(/<p>([\s\S]*?)<\/p>/i)
  const intro = introMatch?.[1] || 'Clear, practical guidance for public-safety technology teams.'
  if (introMatch) styled = styled.replace(introMatch[0], '')
  styled = styled
    .replace(/<p>/g, '<p style="font-family:Ubuntu,Arial,sans-serif!important;font-size:1rem!important;line-height:1.7!important;margin:0 0 1.25rem;">')
    .replace(/<ul>/g, '<ul style="font-family:Ubuntu,Arial,sans-serif!important;font-size:1rem!important;line-height:1.7!important;margin:0 0 1.5rem;padding-left:1.5rem;">')
    .replace(/<ol>/g, '<ol style="font-family:Ubuntu,Arial,sans-serif!important;font-size:1rem!important;line-height:1.7!important;margin:0 0 1.5rem;padding-left:1.5rem;">')
    .replace(/<li>/g, '<li style="font-family:Ubuntu,Arial,sans-serif!important;font-size:1rem!important;line-height:1.7!important;margin:0 0 .6rem;">')
    .replace(/<blockquote>/g, '<blockquote style="margin:2rem 0;padding:1.5rem 1.75rem;border-left:4px solid #aaa48a;background:#f4f2ec;">')
  const h2Matches = [...styled.matchAll(/<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi)]
  const toc = h2Matches.length
    ? `<ul style="margin:0;padding-left:1.25rem;">${h2Matches.map(([, id, label]) => `<li style="margin:0 0 .5rem;"><a href="#${id}" style="color:#555748;text-decoration:none;">${label.replace(/<[^>]+>/g, '')}</a></li>`).join('')}</ul>`
    : ''

  return `<article class="tt-field-guide" style="box-sizing:border-box;width:100%;max-width:1040px;margin:0 auto;padding:3rem clamp(1rem,4vw,3rem) 6rem;color:#34352f;font-family:Ubuntu,Arial,sans-serif!important;font-size:16px!important;line-height:1.7!important;overflow-wrap:anywhere;"><header style="display:flex;flex-wrap:wrap;width:100%;margin:0 auto 4rem;background:#f7f6f2;border:1px solid #e2dfd5;font-family:Ubuntu,Arial,sans-serif!important;"><div style="flex:1 1 600px;padding:clamp(2rem,6vw,5rem);"><div style="margin-bottom:2rem;font-size:.72rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#696a5d;">Trusted Tech Knowledge Center &nbsp;•&nbsp; Field Guide</div><h1 style="font-family:Ubuntu,Arial,sans-serif!important;max-width:760px;margin:0 0 1.5rem;font-size:clamp(2.4rem,5vw,4.8rem)!important;line-height:1!important;letter-spacing:-.045em;color:#34352f;">${escapeHtml(title || 'Trusted Technology Field Guide')}</h1><div style="max-width:680px;font-family:Ubuntu,Arial,sans-serif!important;font-size:clamp(1rem,1.5vw,1.2rem)!important;line-height:1.65!important;color:#66675f;">${intro}</div><div style="margin-top:2.5rem;padding-top:1.25rem;border-top:1px solid #d8d5ca;font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#737467;">Trusted Technology &nbsp;•&nbsp; Practical guidance for the field</div></div><div style="flex:1 1 280px;display:flex;align-items:flex-end;min-height:300px;padding:2.5rem;background:#555748;color:#fff;"><strong style="font-family:Ubuntu,Arial,sans-serif!important;max-width:260px;font-size:clamp(2rem,3vw,3rem)!important;line-height:1.04!important;letter-spacing:-.04em;color:#f3f1ea;">Clear guidance.<br>Built for the field.</strong></div></header><div style="width:100%;max-width:780px;margin:0 auto;"><aside style="width:100%;margin:0 auto 3rem;padding:1.5rem 1.75rem;background:#f4f2ec;border-left:4px solid #aaa48a;font-family:Ubuntu,Arial,sans-serif!important;font-size:.9rem!important;line-height:1.5!important;" aria-label="In this article"><div style="margin-bottom:1rem;font-size:.7rem;font-weight:900;letter-spacing:.14em;text-transform:uppercase;">In this article</div>${toc || '<p>Article sections appear in the guide.</p>'}</aside><div style="font-family:Ubuntu,Arial,sans-serif!important;margin:0 0 3rem;padding:1.5rem 1.75rem;border-left:4px solid #aaa48a;background:#f4f2ec;"><span style="display:block;margin-bottom:.5rem;font-size:.65rem;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#777565;">Article overview</span>${intro}</div>${styled}<div style="font-family:Ubuntu,Arial,sans-serif!important;margin:4rem 0 0;padding:2.25rem;border-radius:18px;background:#555748;color:#fff;"><small style="display:block;margin-bottom:1.25rem;font-size:.65rem;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#d7d2bd;">Trusted Technology</small><strong style="font-family:Ubuntu,Arial,sans-serif!important;display:block;max-width:560px;font-size:clamp(2rem,4vw,3.4rem)!important;line-height:1.04!important;letter-spacing:-.04em;color:#d7d2bd;">Technology that supports the work behind the badge.</strong></div></div></article>`
}

export function markdownToWordPressHtml(markdown, { title = '' } = {}) {
  const renderer = new Renderer()
  renderer.html = ({ text }) => escapeHtml(text)
  const cleaned = stripProductionNotes(removeDuplicateTitle(markdown, title))
  const html = marked.parse(cleaned, {
    renderer,
    gfm: true,
    breaks: false,
    async: false,
  }).trim()
  return formatResourceArticle(html, title)
}
