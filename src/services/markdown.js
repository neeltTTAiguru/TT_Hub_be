import { marked, Renderer } from 'marked'

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
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
  const withAnchors = String(html).replace(/<h([23])>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => {
    const base = slugifyHeading(content) || `section-${usedIds.size + 1}`
    const count = usedIds.get(base) || 0
    usedIds.set(base, count + 1)
    const id = count ? `${base}-${count + 1}` : base
    const style = level === '2'
      ? 'font-size:clamp(1.65rem,3vw,2.35rem);line-height:1.2;margin:3rem 0 1rem;color:#37372f;scroll-margin-top:7rem;'
      : 'font-size:clamp(1.25rem,2vw,1.6rem);line-height:1.3;margin:2rem 0 .75rem;color:#4a4941;scroll-margin-top:7rem;'
    return `<h${level} id="${id}" style="${style}">${content}</h${level}>`
  })

  let styled = withAnchors
    .replace(/<p>/g, '<p style="margin:0 0 1.25rem;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 1.5rem 1.5rem;padding:0;list-style:disc;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 1.5rem 1.5rem;padding:0;list-style:decimal;">')
    .replace(/<li>/g, '<li style="margin:.45rem 0;padding-left:.25rem;">')
    .replace(/<blockquote>/g, '<blockquote style="margin:2rem 0;padding:1.25rem 1.5rem;border-left:4px solid #a9a38b;background:#f5f3ed;">')
    .replace(/<table>/g, '<div style="overflow-x:auto;margin:2rem 0;"><table style="width:100%;border-collapse:collapse;">')
    .replace(/<\/table>/g, '</table></div>')
    .replace(/<(th|td)>/g, '<$1 style="padding:.75rem;border:1px solid #d8d5ca;text-align:left;vertical-align:top;">')

  const introMatch = styled.match(/<p style="[^"]*">([\s\S]*?)<\/p>/i)
  const intro = introMatch?.[1] || 'Clear, practical guidance for public-safety technology teams.'
  if (introMatch) styled = styled.replace(introMatch[0], '')

  const tocMatch = styled.match(/<h2 id="table-of-contents"[^>]*>[\s\S]*?<\/h2>\s*(<ul[^>]*>[\s\S]*?<\/ul>)/i)
  if (tocMatch) styled = styled.replace(tocMatch[0], '')
  const h2Matches = [...styled.matchAll(/<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi)]
  const toc = h2Matches.length
    ? `<ul>${h2Matches.map(([, id, label]) => `<li><a href="#${id}">${label.replace(/<[^>]+>/g, '')}</a></li>`).join('')}</ul>`
    : ''

  return `<article class="tt-field-guide" style="box-sizing:border-box;width:100%;max-width:1040px;margin:0 auto;padding:3rem clamp(1rem,4vw,3rem) 6rem;color:#34352f;font-family:Arial,sans-serif;overflow-wrap:anywhere;">
  <header class="tt-guide-cover" style="display:flex;flex-wrap:wrap;width:100%;margin:0 auto 4rem;background:#f7f6f2;border:1px solid #e2dfd5;">
    <div class="tt-guide-cover-main" style="flex:1 1 600px;padding:clamp(2rem,6vw,5rem);">
      <div class="tt-guide-eyebrow" style="margin-bottom:2rem;font-size:.72rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#696a5d;">Trusted Tech Knowledge Center &nbsp;•&nbsp; Field Guide</div>
      <h1 class="tt-guide-title" style="max-width:760px;margin:0 0 1.5rem;font-size:clamp(2.4rem,5vw,4.8rem);line-height:1;letter-spacing:-.045em;color:#34352f;">${escapeHtml(title || 'Trusted Technology Field Guide')}</h1>
      <div class="tt-guide-deck" style="max-width:680px;font-size:clamp(1rem,1.5vw,1.2rem);line-height:1.65;color:#66675f;">${intro}</div>
      <div class="tt-guide-brandline" style="margin-top:2.5rem;padding-top:1.25rem;border-top:1px solid #d8d5ca;font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#737467;">Trusted Technology &nbsp;•&nbsp; Practical guidance for the field</div>
    </div>
    <div class="tt-guide-cover-side" style="flex:1 1 280px;display:flex;align-items:flex-end;min-height:300px;padding:2.5rem;background:#555748;color:#fff;"><strong style="max-width:260px;font-size:clamp(2rem,3vw,3rem);line-height:1.04;letter-spacing:-.04em;">Clear guidance.<br>Built for the field.</strong></div>
  </header>
  <div class="tt-guide-layout" style="width:100%;max-width:780px;margin:0 auto;">
    <aside class="tt-guide-rail" aria-label="In this article" style="width:100%;margin:0 auto 3rem;padding:1.5rem 1.75rem;background:#f4f2ec;border-left:4px solid #aaa48a;font-size:.9rem;line-height:1.5;">
      <div class="tt-guide-rail-title" style="margin-bottom:1rem;font-size:.7rem;font-weight:900;letter-spacing:.14em;text-transform:uppercase;">In this article</div>
      ${toc || '<p>Article sections appear in the guide.</p>'}
    </aside>
    <main class="tt-guide-content" style="width:100%;max-width:780px;margin:0 auto;font-size:clamp(1rem,1.2vw,1.1rem);line-height:1.78;color:#55564f;">
      <div class="tt-guide-overview" style="margin:0 0 3rem;padding:1.5rem 1.75rem;border-left:4px solid #aaa48a;background:#f4f2ec;"><span class="tt-guide-overview-label" style="display:block;margin-bottom:.5rem;font-size:.65rem;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#777565;">Article overview</span>${intro}</div>
      ${styled}
      <div class="tt-guide-cta" style="margin:4rem 0 0;padding:2.25rem;border-radius:18px;background:#555748;color:#fff;"><small style="display:block;margin-bottom:1.25rem;font-size:.65rem;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#d7d2bd;">Trusted Technology</small><strong style="display:block;max-width:560px;font-size:clamp(2rem,4vw,3.4rem);line-height:1.04;letter-spacing:-.04em;">Technology that supports the work behind the badge.</strong></div>
    </main>
  </div>
</article>`
}

export function markdownToWordPressHtml(markdown, { title = '' } = {}) {
  const renderer = new Renderer()
  renderer.html = ({ text }) => escapeHtml(text)
  const html = marked.parse(removeDuplicateTitle(markdown, title), {
    renderer,
    gfm: true,
    breaks: false,
    async: false,
  }).trim()
  return formatResourceArticle(html, title)
}
