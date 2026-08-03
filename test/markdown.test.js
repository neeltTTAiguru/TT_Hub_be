import test from 'node:test'
import assert from 'node:assert/strict'
import { markdownToWordPressHtml } from '../src/services/markdown.js'

test('converts Hermes Markdown to WordPress-ready HTML', () => {
  const html = markdownToWordPressHtml(`
# Article title

## Main section

This has **bold text** and a [safe link](https://example.com).

- First
- Second
`, { title: 'Article title' })

  assert.doesNotMatch(html, /<h1>/)
  assert.match(html, /<h2 id="main-section"[^>]*>Main section<\/h2>/)
  assert.match(html, /<strong>bold text<\/strong>/)
  assert.match(html, /<a href="https:\/\/example\.com">safe link<\/a>/)
  assert.match(html, /<ul style=/)
  assert.match(html, /class="tt-field-guide"/)
})

test('escapes raw HTML from generated Markdown', () => {
  const html = markdownToWordPressHtml('<script>alert("unsafe")</script>')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})
