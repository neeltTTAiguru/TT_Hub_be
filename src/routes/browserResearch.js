import { Router } from 'express'
import {
  capturePublicPage,
  ensureBrowserStarted,
  saveBrowserResearchRun,
  saveCapturedPublicPage,
} from '../services/browserResearch.js'
import { validateExternalUrl } from '../middleware/urlSafety.js'

const router = Router()

router.post('/start', async (_req, res, next) => {
  try {
    await ensureBrowserStarted()
    res.json({ status: 'ok' })
  } catch (error) {
    next(error)
  }
})

router.post('/capture-page', async (req, res, next) => {
  try {
    const url = validateExternalUrl(req.body?.url)
    const objective =
      typeof req.body?.objective === 'string' && req.body.objective.trim()
        ? req.body.objective.trim()
        : `Capture public page for research: ${url}`

    const page = await capturePublicPage(url)
    const savedPage = await saveCapturedPublicPage(page)
    const run = await saveBrowserResearchRun({ objective, page: savedPage })

    return res.json({
      page: savedPage,
      researchRun: run,
    })
  } catch (error) {
    return next(error)
  }
})

export default router
