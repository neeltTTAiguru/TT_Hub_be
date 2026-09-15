import test from 'node:test'
import assert from 'node:assert/strict'
import { findInSitemap, normaliseUrl, parseSitemap } from '../src/services/sitemap.js'

const INDEX = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://trustedtechnology.ai/post-sitemap.xml</loc><lastmod>2026-09-07T19:43:14+00:00</lastmod></sitemap>
<sitemap><loc>https://trustedtechnology.ai/page-sitemap.xml</loc></sitemap>
</sitemapindex>`

const URLSET = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url><loc>https://trustedtechnology.ai/commercial-body-worn-camera-use-cases-2/</loc><lastmod>2026-09-07T19:43:14+00:00</lastmod>
<image:image><image:loc>https://trustedtechnology.ai/wp-content/uploads/x.avif</image:loc></image:image></url>
<url><loc>https://trustedtechnology.ai/other/</loc></url>
</urlset>`

test('parseSitemap reads an index and a urlset', () => {
  const index = parseSitemap(INDEX)
  assert.equal(index.type, 'index')
  assert.deepEqual(index.entries, [
    { loc: 'https://trustedtechnology.ai/post-sitemap.xml', lastmod: '2026-09-07T19:43:14+00:00' },
    { loc: 'https://trustedtechnology.ai/page-sitemap.xml', lastmod: '' },
  ])
  const set = parseSitemap(URLSET)
  assert.equal(set.type, 'urlset')
  assert.equal(set.entries.length, 2)
  // image:loc must not be mistaken for a page URL
  assert.equal(set.entries[0].loc, 'https://trustedtechnology.ai/commercial-body-worn-camera-use-cases-2/')
})

test('findInSitemap ignores trailing slashes, case of host and query strings', () => {
  const sitemap = { urls: parseSitemap(URLSET).entries }
  assert.ok(findInSitemap(sitemap, 'https://TrustedTechnology.ai/commercial-body-worn-camera-use-cases-2?utm=x'))
  assert.equal(findInSitemap(sitemap, 'https://trustedtechnology.ai/missing/'), null)
  assert.equal(normaliseUrl('not a url'), '')
})
