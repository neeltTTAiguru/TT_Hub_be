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
  revertArticleRevision,
  startContentOperationsRun,
  stopContentOperationsRun,
  trashWordPressDraftForRun,
  publishToTestBlog,
} from '../services/contentOperations.js'
import { generateArticleImagesForDraft } from '../services/articleImages.js'
import { createPdfDownloadToken } from '../services/articlePdf.js'
import { getGa4ConnectionStatus, getGa4Snapshot } from '../services/ga4Analytics.js'
import { verifyWordPressAuthentication } from '../services/wordpress.js'

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
