import { Router } from 'express'
import {
  capturePublicPage,
  ensureBrowserStarted,
  saveBrowserResearchRun,
  saveCapturedPublicPage,
} from '../services/browserResearch.js'

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
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
    const objective =
      typeof req.body?.objective === 'string' && req.body.objective.trim()
        ? req.body.objective.trim()
        : `Capture public page for research: ${url}`

    if (!url) {
      return res.status(400).json({ message: 'A URL is required.' })
    }

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
