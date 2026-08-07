import test from 'node:test'
import assert from 'node:assert/strict'
import { markdownToWordPressHtml, stripProductionNotes } from '../src/services/markdown.js'

test('converts Hermes Markdown to WordPress-ready HTML', () => {
  const html = markdownToWordPressHtml(`
# Article title

## Main section

This has **bold text** and a [safe link](https://example.com).

- First
- Second
`, { title: 'Article title' })

  assert.equal((html.match(/<h1\b/g) || []).length, 1)
  assert.match(html, /<h1 style="[^"]+">Article title<\/h1>/)
  assert.match(html, /<h2 id="main-section"[^>]*>Main section<\/h2>/)
  assert.match(html, /<strong>bold text<\/strong>/)
  assert.match(html, /<a href="https:\/\/example\.com">safe link<\/a>/)
  assert.match(html, /<ul style="[^"]*margin:0 0 1\.5rem/)
  assert.match(html, /class="tt-field-guide"/)
  assert.match(html, /font-family:Ubuntu,Arial,sans-serif!important/)
  assert.match(html, /font-size:1rem!important/)
  assert.match(html, /background:#555748/)
  assert.match(html, /border-left:4px solid #aaa48a/)
  assert.doesNotMatch(html, /<style>/)
})

test('strips a leaked featured-image production note (the exact draft-1222 leak)', () => {
  const leaked = `## How the T500 fits a repossession workflow

The T500 records the full recovery from arrival to release.

*Featured image placement, after this section: Role: featured. Source: approved_t500_reference. Use the canonical T500 camera at assets/article-images/t500-camera-reference.png, combined with a calm, professional vehicle-recovery environment. Do not redesign the device or imply undocumented features.*

Agents keep the footage as a neutral record of the encounter.`

  const cleaned = stripProductionNotes(leaked)
  assert.doesNotMatch(cleaned, /Featured image placement/i)
  assert.doesNotMatch(cleaned, /assets\/article-images/i)
  assert.doesNotMatch(cleaned, /Role:\s*featured/i)
  // real prose and the heading are preserved
  assert.match(cleaned, /How the T500 fits a repossession workflow/)
  assert.match(cleaned, /records the full recovery/)
  assert.match(cleaned, /neutral record of the encounter/)

  // and it never survives the HTML render either
  const html = markdownToWordPressHtml(leaked, { title: 'Repo article' })
  assert.doesNotMatch(html, /Featured image placement/i)
  assert.doesNotMatch(html, /assets\/article-images/i)
})

test('keeps ordinary prose that merely mentions images or the camera', () => {
  const md = `## Choosing a camera

A good body camera captures a clear image even in low light, and the operator can review each recording later.`
  const cleaned = stripProductionNotes(md)
  assert.match(cleaned, /clear image even in low light/)
  assert.match(cleaned, /Choosing a camera/)
})

test('escapes raw HTML from generated Markdown', () => {
  const html = markdownToWordPressHtml('<script>alert("unsafe")</script>')
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})
