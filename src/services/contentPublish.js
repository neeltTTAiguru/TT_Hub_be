import crypto from 'node:crypto'
import ContentOperationsRun from '../models/ContentOperationsRun.js'
import { createWordPressDraftForRun } from './contentOperations.js'
import { getWordPressEditorUrl } from './wordpress.js'

// The publish phase works on a chat-authored article, which has no run behind it —
// the Write page talks to Hermes directly and keeps the draft in the browser. Every
// WordPress function downstream speaks the run model, so this mints one to carry the
// draft across, or reuses the run the SEO pass already made for it.

function clean(value, max = 300) {
  return String(value || '').replace(/[*_`]/g, '').trim().slice(0, max)
}

// The writer ends an article with a `---` rule and a block of publishing metadata
// for the editor. Those lines are the brief: they name the meta title, the slug and
// the description the WordPress draft should carry.
function field(body, ...names) {
  for (const name of names) {
    const match = body.match(new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im'))
    if (match) return clean(match[1], 500)
  }
  return ''
}

function list(body, ...names) {
  const raw = field(body, ...names)
  return raw ? raw.split(/[,;]/).map((item) => clean(item, 200)).filter(Boolean) : []
}

export function briefFromDraft(article, title = '') {
  const heading = clean(article.match(/^#\s+(.+)$/m)?.[1] || '')
  const metaTitle = field(article, 'Meta title', 'SEO title')
  const slug = field(article, 'Slug', 'Recommended slug')
  const proposedTitle = metaTitle || heading || clean(title) || 'Trusted Tech Article'
  return {
    proposedTitle,
    slug,
    // Kept separately so Yoast's SEO title is set only when the writer chose one.
    metaTitle,
    metaDescription: field(article, 'Meta description', 'Description'),
    primaryKeyword: field(article, 'Primary keyword', 'Target keyword')
      || (slug ? slug.replace(/-/g, ' ') : proposedTitle),
    category: field(article, 'Category'),
    tags: list(article, 'Tags', 'Tag'),
  }
}

// The panel's artwork is already generated and uploaded to WordPress media. Seeding
// it onto the run means the draft build finds every role it planned for and skips
// generation entirely, rather than paying for a second set of the same images.
function seedImages(run, images) {
  if (!Array.isArray(images) || !images.length) return
  const merged = Array.isArray(run.generatedImages) ? [...run.generatedImages] : []
  for (const image of images) {
    if (!image?.role) continue
    const index = merged.findIndex((existing) => existing?.role === image.role)
    if (index === -1) merged.push(image)
    else merged[index] = { ...merged[index], ...image }
  }
  run.generatedImages = merged
}

export async function prepareRunForDraft({ article, images = [], runId = '', title = '' }) {
  const body = String(article || '').trim()
  if (body.length < 200) {
    throw Object.assign(new Error('Write the article before creating the WordPress draft.'), { statusCode: 400 })
  }
  const brief = briefFromDraft(body, title)
  const existing = runId ? await ContentOperationsRun.findOne({ runId }) : null
  const run = existing || new ContentOperationsRun({
    runId: crypto.randomUUID(),
    targetDomain: process.env.CONTENT_OPS_TARGET_DOMAIN || 'trustedtechnology.ai',
    requestType: 'publish',
    userInstructions: `Publish "${brief.proposedTitle}"`,
    workflowMode: 'manual',
    researchOnly: false,
    currentStage: 'article_generation',
    status: 'ready',
  })
  // The panel is the source of truth for the article: it holds whatever the SEO pass
  // and the editor left behind, so a stale run copy must never win.
  run.article = body
  run.brief = { ...(run.brief || {}), ...brief }
  seedImages(run, images)
  // Publishing is a deliberate human action taken on this page. Reaching here means
  // the person looking at the draft asked for it, which is the approval the WordPress
  // functions guard on.
  run.approval.article = true
  await run.save()
  return run
}

export function publishStateFor(run) {
  const publication = run.wordpressPublication || {}
  const postId = publication.postId || null
  return {
    runId: run.runId,
    postId,
    status: publication.status || '',
    published: publication.status === 'publish',
    title: publication.title || run.brief?.proposedTitle || '',
    slug: publication.slug || run.brief?.slug || '',
    url: publication.url || '',
    // Where the person goes to finish the job by hand: the post in the WordPress
    // editor, which is the only place it can be published from.
    editorUrl: postId ? getWordPressEditorUrl(postId) : '',
  }
}

export async function createDraftFromChatArticle(payload) {
  const run = await prepareRunForDraft(payload)
  return publishStateFor(await createWordPressDraftForRun(run))
}

export async function publishStateForRunId(runId) {
  const run = await ContentOperationsRun.findOne({ runId: String(runId || '') })
  return run ? publishStateFor(run) : null
}
