import 'dotenv/config'
import { buildBlogIndexHtml } from '../src/services/wordpressDraftEditor.js'
import { getWordPressDraft, listWordPressPublishedPosts, updateWordPressDraft } from '../src/services/wordpress.js'

const draftId = process.argv[2]
if (!draftId) throw new Error('Usage: npm run wordpress:refresh-blog -- DRAFT_ID')

const draft = await getWordPressDraft(draftId)
if (draft.type !== 'page') throw new Error(`WordPress item ${draftId} is not a page draft.`)
const posts = await listWordPressPublishedPosts({ perPage: 12, status: 'any' })
await updateWordPressDraft(draft, {
  title: 'Blog',
  slug: 'blog',
  excerpt: 'Trusted Technology articles, field guides, and public-safety technology insights.',
  content: buildBlogIndexHtml(posts),
})
const verified = await getWordPressDraft(draftId)
console.log(JSON.stringify({ id: verified.id, title: verified.title?.raw || verified.title?.rendered, status: verified.status, articles: posts.length, link: verified.link }))
