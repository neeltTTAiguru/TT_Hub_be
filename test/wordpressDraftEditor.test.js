import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBlogIndexHtml, buildDynamicBlogIndexHtml, extractDraftId, inferWordPressAction, isBlogTemplateEdit, validateArticleTemplateDesign, validateDynamicBlogIndexHtml } from '../src/services/wordpressDraftEditor.js'

test('extracts a WordPress draft ID from common user inputs', () => {
  assert.equal(extractDraftId('Edit draft 1113'), '1113')
  assert.equal(extractDraftId('Change post #1113'), '1113')
  assert.equal(extractDraftId('https://example.com/wp-admin/post.php?post=1113&action=edit'), '1113')
})

test('does not treat an unrelated number as a draft ID', () => {
  assert.equal(extractDraftId('make the font 16 pixels'), null)
})

test('routes an explicit draft page creation without a model planning call', () => {
  const action = inferWordPressAction('Create a WordPress draft page titled “Blog” using https://example.com as inspiration')
  assert.equal(action.operation, 'create_page')
  assert.equal(action.title, 'Blog')
})

test('routes blog articles separately from site pages', () => {
  assert.equal(inferWordPressAction('Write a blog post about evidence retention').operation, 'create_post')
})

test('detects requests that imply a live navigation change', () => {
  assert.equal(inferWordPressAction('Create a page beside Industries').navigationRequested, true)
})

test('never routes delete language into page creation', () => {
  const action = inferWordPressAction('delete all blogs in the draft page for 1145')
  assert.equal(action.operation, 'delete_request')
  assert.equal(action.reference, '1145')
})

test('treats a requested draft titled Blog as a page', () => {
  assert.equal(inferWordPressAction('Create a draft titled “Blog” with article cards').operation, 'create_page')
})

test('keeps explicit creation intent despite later negative edit language', () => {
  const prompt = 'Create a new WordPress draft page titled “Blog”. Include the existing WordPress post titled “Trusted Vault vs. Generic Cloud Storage for Body-Worn Cameras.” Do not modify the original article or change navigation.'
  const action = inferWordPressAction(prompt)
  assert.equal(action.operation, 'create_page')
  assert.equal(action.title, 'Blog')
})

test('builds a neat article-card blog index from WordPress posts', () => {
  const html = buildBlogIndexHtml([{
    title: { rendered: 'Body Camera Guide' },
    excerpt: { rendered: '<p>A practical guide for public safety teams.</p>' },
    date: '2026-07-01T12:00:00',
    link: 'https://trustedtechnology.ai/body-camera-guide/',
    _embedded: {
      'wp:featuredmedia': [{ source_url: 'https://trustedtechnology.ai/image.jpg' }],
      'wp:term': [[{ taxonomy: 'category', name: 'Field Guides' }]],
    },
  }])
  assert.match(html, /Latest Articles/)
  assert.match(html, /Body Camera Guide/)
  assert.match(html, /Read Story/)
  assert.match(html, /background:#57584A/)
  assert.match(html, /grid-template-columns:repeat\(auto-fit/)
  assert.match(html, /aspect-ratio:16\/9/)
  assert.match(html, /image\.jpg/)
})

test('excludes prior Blog-index artifacts from article cards', () => {
  const html = buildBlogIndexHtml([
    { title: { rendered: 'Blog Page' }, slug: 'blog-page', excerpt: { rendered: 'Draft blog landing page' }, link: '#' },
    { title: { rendered: 'Real Field Guide' }, slug: 'real-field-guide', excerpt: { rendered: 'Useful article' }, link: '/real/' },
  ])
  assert.doesNotMatch(html, />Blog Page</)
  assert.match(html, /Real Field Guide/)
})

test('builds a dynamic WordPress Query Loop for future articles', () => {
  const html = buildDynamicBlogIndexHtml()
  assert.match(html, /wp:query/)
  assert.match(html, /wp:post-template/)
  assert.match(html, /wp:post-featured-image/)
  assert.match(html, /wp:post-title/)
  assert.match(html, /wp:post-excerpt/)
  assert.match(html, /Read Story/)
})

test('routes Blog visual changes through the deterministic template', () => {
  assert.equal(isBlogTemplateEdit({ type: 'page', title: { raw: 'Blog' } }, 'make the colors match the website'), true)
  assert.equal(isBlogTemplateEdit({ type: 'post', title: { raw: 'Blog' } }, 'change the colors'), false)
})

test('validates all required dynamic Blog structure and palette markers', () => {
  assert.equal(validateDynamicBlogIndexHtml(buildDynamicBlogIndexHtml()), true)
  assert.throws(() => validateDynamicBlogIndexHtml('<p>broken</p>'), /Blog template validation failed/)
})

test('requires generated articles to preserve canonical design classes and styles', () => {
  const template = '<article class="tt-field-guide" style="color:var(--wp--preset--color--contrast)"><div class="tt-article-hero" style="padding:40px">Old copy</div></article>'
  const generated = '<article class="tt-field-guide" style="color:var(--wp--preset--color--contrast)"><div class="tt-article-hero" style="padding:40px">New copy</div></article>'
  assert.equal(validateArticleTemplateDesign(template, generated), true)
  assert.throws(
    () => validateArticleTemplateDesign(template, generated.replace('padding:40px', 'padding:20px')),
    /did not preserve the canonical article design/,
  )
})
