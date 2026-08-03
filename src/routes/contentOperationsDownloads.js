import { Router } from 'express'
import { createArticlePdfBuffer, resolvePdfDownload } from '../services/articlePdf.js'
import ArticleAsset from '../models/ArticleAsset.js'

const router = Router()

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
    const slug = run.testPublication.slug || 'trusted-tech-article'
    const heroAsset = await ArticleAsset.findOne({ runId: run.runId, role: 'hero' }).select('+data')
    const pdf = await createArticlePdfBuffer(run.testPublication.title, run.article, {
      description: run.brief?.metaDescription || run.selectedOpportunity?.rationale || '',
      publishedAt: run.testPublication.publishedAt,
      heroImage: heroAsset?.data,
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
