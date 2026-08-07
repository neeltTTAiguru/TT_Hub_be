import { Router } from 'express'
import { createArticlePdfBuffer, resolvePdfDownload } from '../services/articlePdf.js'
import ArticleAsset from '../models/ArticleAsset.js'

const router = Router()

async function fetchHeroImage(run) {
  const url = run.generatedImages?.find((image) => image.role === 'featured')?.url
  if (!url) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

router.get('/asset/:assetId', async (req, res, next) => {
  try {
    const asset = await ArticleAsset.findById(req.params.assetId).select('+data')
    if (!asset) return res.status(404).json({ message: 'Article image not found.' })
    res.set({
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.data.length),
      'Cache-Control': 'public, max-age=86400',
      'Content-Disposition': `inline; filename="${asset.filename.replace(/"/g, '')}"`,
      'Cross-Origin-Resource-Policy': 'cross-origin',
    })
    return res.send(asset.data)
  } catch (error) {
    return next(error)
  }
})

router.get('/:token', async (req, res, next) => {
  try {
    const run = await resolvePdfDownload(req.params.token)
    if (!run) return res.status(404).json({ message: 'This PDF download link is invalid or expired.' })
    const slug = run.wordpressPublication?.slug || run.testPublication?.slug || 'trusted-tech-article'
    const heroAsset = await ArticleAsset.findOne({ runId: run.runId, role: 'hero' }).select('+data')
    const heroImage = heroAsset?.data || await fetchHeroImage(run)
    const title = run.wordpressPublication?.title || run.testPublication?.title || run.brief?.proposedTitle || 'Trusted Technology Article'
    const pdf = await createArticlePdfBuffer(title, run.article, {
      description: run.brief?.metaDescription || run.selectedOpportunity?.rationale || '',
      publishedAt: run.testPublication?.publishedAt || run.wordpressPublication?.createdAt,
      heroImage,
    })
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${slug}.pdf"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'private, no-store',
    })
    return res.send(pdf)
  } catch (error) {
    return next(error)
  }
})

export default router
