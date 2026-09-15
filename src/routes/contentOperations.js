import { Router } from 'express'
import ContentOperationsRun from '../models/ContentOperationsRun.js'
import ArticleAsset from '../models/ArticleAsset.js'
import {
  approveArticle,
  approveBriefAndDraft,
  approveOpportunity,
  contentIntegrationStatus,
  createWordPressDraftForRun,
  publishWordPressPostForRun,
  restartContentOperationsRun,
  applyQuickFixToRun,
  applyRejectedRevision,
  revertQuickFix,
  reviseArticleForRun,
  proposeKeywordFixes,
  proposeSurferFixes,
  revertArticleRevision,
  startContentOperationsRun,
  stopContentOperationsRun,
  trashWordPressDraftForRun,
  publishToTestBlog,
} from '../services/contentOperations.js'
import { generateArticleImagesForDraft } from '../services/articleImages.js'
import { startSeoPassForDraft } from '../services/contentSeoPass.js'
import { createDraftFromChatArticle, publishStateForRunId } from '../services/contentPublish.js'
import { createPdfDownloadToken } from '../services/articlePdf.js'
import { getGa4ConnectionStatus, getGa4Snapshot } from '../services/ga4Analytics.js'
import { verifyWordPressAuthentication } from '../services/wordpress.js'
import { getSitemapStatus, refreshSitemap, runSitemapWatchTick } from '../services/sitemap.js'

const router = Router()

// Artwork for a chat-authored draft, which has no run to hang stages off. The
// article text is supplied by the caller and nothing is persisted here; the
// images are uploaded to WordPress media and handed straight back.
router.post('/draft-images', async (req, res, next) => {
  try {
    const article = String(req.body?.article || '').trim()
    if (article.length < 200) {
      return res.status(400).json({ message: 'Send the article draft to illustrate.' })
    }
    const images = await generateArticleImagesForDraft({
      article,
      title: String(req.body?.title || '').trim(),
      primaryKeyword: String(req.body?.primaryKeyword || '').trim(),
      instructions: String(req.body?.instructions || '').trim(),
    })
    return res.json({ images })
  } catch (error) {
    return next(error)
  }
})

// Takes an article written in chat through the SEO pass: a run is minted to
// hold it, Surfer builds SERP guidelines for the keyword, scores the draft and
// revises it. Guidelines alone can take minutes, so this returns immediately and
// the caller polls GET /runs/:runId.
router.post('/seo-pass', async (req, res, next) => {
  try {
    const article = String(req.body?.article || '').trim()
    if (article.length < 200) {
      return res.status(400).json({ message: 'Send the article to optimise.' })
    }
    const run = await startSeoPassForDraft({
      article,
      title: String(req.body?.title || '').trim(),
      primaryKeyword: String(req.body?.primaryKeyword || '').trim(),
      guidance: String(req.body?.guidance || '').trim(),
    })
    return res.status(202).json({ runId: run.runId, status: run.status })
  } catch (error) {
    return next(error)
  }
})

// Phase 3 — handing a chat-authored article to WordPress. The draft lives in the
// browser, so it is sent up here: a run is minted to carry it, the WordPress draft
// is built from it, and the caller gets back the link the person needs — the post
// in the WordPress editor, which is where they publish it themselves.
router.post('/publish/wordpress-draft', async (req, res, next) => {
  try {
    return res.json(await createDraftFromChatArticle({
      article: String(req.body?.article || ''),
      images: Array.isArray(req.body?.images) ? req.body.images : [],
      runId: String(req.body?.runId || ''),
      title: String(req.body?.title || ''),
    }))
  } catch (error) {
    return next(error)
  }
})

// Ahrefs placement fixes for the article the editor is looking at. Stateless on
// purpose: the draft lives in the browser and no run is minted, because nothing
// is being changed — the edits come back as proposals and only the editor's
// accept, in the panel, ever applies one.
router.post('/article/keyword-fixes', async (req, res, next) => {
  try {
    return res.json(await proposeKeywordFixes({
      article: String(req.body?.article || ''),
      keywords: Array.isArray(req.body?.keywords) ? req.body.keywords : [],
    }))
  } catch (error) {
    return next(error)
  }
})

// Surfer's coverage fixes for the article on screen. Same contract as the Ahrefs
// route: proposals out, nothing applied.
router.post('/article/surfer-fixes', async (req, res, next) => {
  try {
    return res.json(await proposeSurferFixes({
      article: String(req.body?.article || ''),
      guidelines: req.body?.guidelines && typeof req.body.guidelines === 'object' ? req.body.guidelines : {},
      gaps: Array.isArray(req.body?.gaps) ? req.body.gaps : [],
    }))
  } catch (error) {
    return next(error)
  }
})

// Lets the publish page come back after a reload knowing it already has a draft
// in WordPress, so it links to that one rather than creating a second post.
router.get('/publish/state/:runId', async (req, res, next) => {
  try {
    const state = await publishStateForRunId(req.params.runId)
    if (!state) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(state)
  } catch (error) {
    return next(error)
  }
})

router.get('/integrations', async (_req, res, next) => {
  try {
    return res.json(await contentIntegrationStatus())
  } catch (error) {
    return next(error)
  }
})

router.get('/integrations/ga4/status', async (_req, res, next) => {
  try {
    return res.json(await getGa4ConnectionStatus())
  } catch (error) {
    return next(error)
  }
})

router.get('/integrations/ga4/snapshot', async (_req, res, next) => {
  try {
    const snapshot = await getGa4Snapshot()
    return snapshot
      ? res.json(snapshot)
      : res.status(503).json({ message: 'GA4 is not configured.' })
  } catch (error) {
    return next(error)
  }
})

// The sitemap as the site serves it and as Google last saw it, plus the recent
// refresh log. Reads the live copy (cache bypassed), so it is a few seconds.
router.get('/integrations/sitemap/status', async (_req, res, next) => {
  try {
    return res.json(await getSitemapStatus())
  } catch (error) {
    return next(error)
  }
})

// Manual refresh: verify the given URLs (or just the sitemap itself) and
// re-submit to Search Console / IndexNow. Also what the "Refresh now" button
// in the Content Generator calls.
router.post('/integrations/sitemap/refresh', async (req, res, next) => {
  try {
    const urls = Array.isArray(req.body?.urls) ? req.body.urls.map((url) => String(url || '').trim()).filter(Boolean).slice(0, 50) : []
    if (req.body?.scanWordPress === true) {
      const tick = await runSitemapWatchTick()
      if (tick) return res.json(tick)
    }
    return res.json(await refreshSitemap({ urls, reason: 'manual' }))
  } catch (error) {
    return next(error)
  }
})

router.get('/integrations/wordpress/status', async (_req, res, next) => {
  try {
    return res.json(await verifyWordPressAuthentication())
  } catch (error) {
    return next(error)
  }
})

router.get('/runs', async (_req, res, next) => {
  try {
    return res.json(await ContentOperationsRun.find().sort({ updatedAt: -1 }).limit(20))
  } catch (error) {
    return next(error)
  }
})

router.get('/blog', async (_req, res, next) => {
  try {
    const runs = await ContentOperationsRun.find({ 'testPublication.published': true })
      .sort({ 'testPublication.publishedAt': -1 })
      .lean()
    const assets = await ArticleAsset.find({
      runId: { $in: runs.map((run) => run.runId) },
      role: 'hero',
    }).select('_id runId altText caption').lean()
    const assetsByRun = new Map(assets.map((asset) => [asset.runId, asset]))
    return res.json(runs.map((run) => ({
      ...run,
      heroImage: assetsByRun.has(run.runId)
        ? {
            assetId: assetsByRun.get(run.runId)._id,
            altText: assetsByRun.get(run.runId).altText,
            caption: assetsByRun.get(run.runId).caption,
          }
        : null,
    })))
  } catch (error) {
    return next(error)
  }
})

router.get('/runs/:runId', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    return run ? res.json(run) : res.status(404).json({ message: 'Content pipeline run not found.' })
  } catch (error) {
    return next(error)
  }
})

router.delete('/runs/:runId', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    let wordpressAction = 'none'
    if (run.wordpressPublication?.postId && run.wordpressPublication?.status === 'draft') {
      try {
        await trashWordPressDraftForRun(run)
        wordpressAction = 'trashed_draft'
      } catch (error) {
        if (!/is not a draft/i.test(String(error?.message || ''))) throw error
        wordpressAction = 'left_published'
      }
    }
    await ArticleAsset.deleteMany({ runId: run.runId })
    await ContentOperationsRun.deleteOne({ _id: run._id })
    return res.json({ runId: run.runId, wordpressAction })
  } catch (error) {
    return next(error)
  }
})

router.post('/runs', async (req, res, next) => {
  try {
    return res.status(202).json(await startContentOperationsRun(req.body))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/stop', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(await stopContentOperationsRun(run))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/restart', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.status(202).json(await restartContentOperationsRun(run))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/approve', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    const gate = req.body?.gate
    if (gate === 'opportunity') return res.json(await approveOpportunity(run, req.body.opportunityId))
    if (gate === 'brief') return res.json(await approveBriefAndDraft(run, req.body.brief))
    if (gate === 'article') return res.json(await approveArticle(run))
    return res.status(400).json({ message: 'Unknown approval gate.' })
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/revise', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    // 202: the revision re-runs the pipeline (Ahrefs, rewrite, Surfer passes, sync), so
    // it returns immediately and the client polls the run for stage progress.
    return res.status(202).json(await reviseArticleForRun(run, {
      instruction: req.body?.instruction,
      research: req.body?.research !== false,
      // Off unless asked: regenerating artwork costs money and time, so re-rendering
      // images is an explicit choice rather than a side effect of editing text.
      regenerateImages: req.body?.regenerateImages === true,
      reoptimize: req.body?.reoptimize !== false,
      // Opt-in: by default a revision finishes and reports a score drop rather than
      // abandoning the edit halfway through.
      enforceScoreFloor: req.body?.enforceScoreFloor === true,
      // Editing a live post changes public content, so the client has to ask for it
      // explicitly. Drafts sync without this flag.
      applyToLive: req.body?.applyToLive === true,
    }))
  } catch (error) {
    return next(error)
  }
})

// Little fixes. Unlike /revise this is a single Hermes call that patches the draft in
// place, so it answers on the request rather than handing the client a run to poll.
router.post('/runs/:runId/quick-fix', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(await applyQuickFixToRun(run, {
      instruction: req.body?.instruction,
      applyToLive: req.body?.applyToLive === true,
    }))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/quick-fix-revert', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(await revertQuickFix(run, req.body?.fixId, {
      applyToLive: req.body?.applyToLive === true,
    }))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/apply-revision', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(await applyRejectedRevision(run, req.body?.revisionId, {
      applyToLive: req.body?.applyToLive === true,
    }))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/revert', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(await revertArticleRevision(run, req.body?.revisionId, {
      applyToLive: req.body?.applyToLive === true,
    }))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/test-publish', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(await publishToTestBlog(run))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/wordpress-draft', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(await createWordPressDraftForRun(run))
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/wordpress-publish', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    return res.json(await publishWordPressPostForRun(run))
  } catch (error) {
    return next(error)
  }
})

router.delete('/runs/:runId/wordpress-draft', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({ runId: req.params.runId })
    if (!run) return res.status(404).json({ message: 'Content pipeline run not found.' })
    const result = await trashWordPressDraftForRun(run)
    return res.json(result.run)
  } catch (error) {
    return next(error)
  }
})

router.post('/runs/:runId/pdf-link', async (req, res, next) => {
  try {
    const run = await ContentOperationsRun.findOne({
      runId: req.params.runId,
      article: { $ne: '' },
      'approval.article': true,
    })
    if (!run) return res.status(404).json({ message: 'Completed article not found.' })
    const token = createPdfDownloadToken(run.runId)
    return res.json({ url: `/content-operations-download/${token}` })
  } catch (error) {
    return next(error)
  }
})

export default router
