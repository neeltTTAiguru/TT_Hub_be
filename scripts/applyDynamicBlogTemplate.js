import 'dotenv/config'
import { buildDynamicBlogIndexHtml } from '../src/services/wordpressDraftEditor.js'
import { getWordPressDraft, updateWordPressDraft } from '../src/services/wordpress.js'

const draftId = process.argv[2]
if (!draftId) throw new Error('Usage: node scripts/applyDynamicBlogTemplate.js DRAFT_PAGE_ID')
const draft = await getWordPressDraft(draftId)
if (draft.type !== 'page') throw new Error(`WordPress item ${draftId} is not a page draft.`)
await updateWordPressDraft(draft, {
  title: 'Blog',
  slug: 'blog',
  excerpt: 'Trusted Technology articles, field guides, and public-safety technology insights.',
  content: buildDynamicBlogIndexHtml(),
})
const verified = await getWordPressDraft(draftId)
console.log(JSON.stringify({ id: verified.id, title: verified.title?.raw || verified.title?.rendered, status: verified.status, dynamic: true, link: verified.link }))
