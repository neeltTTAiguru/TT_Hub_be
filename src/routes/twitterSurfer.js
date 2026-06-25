import { Router } from 'express'
import mongoose from 'mongoose'
import ResearchRun from '../models/ResearchRun.js'
import {
  captureBrowserScreenshot,
  captureTwitterKeywordPosts,
  captureTwitterSearchPosts,
  getTwitterBrowserConnectionStatus,
  openBrowserPage,
} from '../services/browserResearch.js'
import {
  defaultTwitterSurferQueries,
  getTwitterSurferTaskRun,
  listTwitterSurferTaskRuns,
  runTwitterSurfer,
  startTwitterSurferTaskRun,
  stopTwitterSurferTaskRun,
} from '../services/twitterSurfer.js'
import { validateExternalUrl } from '../middleware/urlSafety.js'

const router = Router()

router.get('/runs', async (_req, res, next) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json([])
    }

    const runs = await ResearchRun.find({ requestedBy: 'twitter-surfer' }).sort({ createdAt: -1 }).limit(25)
    return res.json(runs)
  } catch (error) {
    return next(error)
  }
})

router.get('/task-runs', (_req, res) => {
  res.json(listTwitterSurferTaskRuns())
})

router.get('/task-runs/:id', (req, res) => {
  const run = getTwitterSurferTaskRun(req.params.id)

  if (!run) {
    return res.status(404).json({ message: 'Twitter Surfer run not found' })
  }

  return res.json(run)
})

router.post('/task-runs', (req, res, next) => {
  try {
    const task = typeof req.body?.task === 'string' ? req.body.task.trim() : ''
    const durationMinutes = req.body?.durationMinutes
    const filter = typeof req.body?.filter === 'string' ? req.body.filter.trim() : 'live'
    const run = startTwitterSurferTaskRun({ task, durationMinutes, filter })

    return res.status(201).json(run)
  } catch (error) {
    return next(error)
  }
})

router.post('/task-runs/:id/stop', async (req, res, next) => {
  try {
    const run = await stopTwitterSurferTaskRun(req.params.id)

    if (!run) {
      return res.status(404).json({ message: 'Twitter Surfer run not found' })
    }

    return res.json(run)
  } catch (error) {
    return next(error)
  }
})

router.get('/default-searches', (_req, res) => {
  res.json({ searches: defaultTwitterSurferQueries })
})

router.get('/connection-status', async (_req, res, next) => {
  try {
    const status = await getTwitterBrowserConnectionStatus()
    return res.json(status)
  } catch (error) {
    return next(error)
  }
})

router.post('/open-session', async (req, res, next) => {
  try {
    const rawUrl =
      typeof req.body?.url === 'string' && req.body.url.trim() ? req.body.url.trim() : 'https://x.com/home'
    const url = validateExternalUrl(rawUrl, { allowedHosts: ['x.com', 'twitter.com'] })

    const page = await openBrowserPage(url)
    return res.json({
      ok: true,
      page,
    })
  } catch (error) {
    return next(error)
  }
})

router.post('/screenshot', async (_req, res, next) => {
  try {
    const screenshot = await captureBrowserScreenshot()
    return res.json(screenshot)
  } catch (error) {
    return next(error)
  }
})

router.post('/capture-posts', async (req, res, next) => {
  try {
    const url = validateExternalUrl(req.body?.url, { allowedHosts: ['x.com', 'twitter.com'] })
    const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : ''

    if (!keyword) {
      return res.status(400).json({ message: 'A keyword is required.' })
    }

    const result = await captureTwitterKeywordPosts(url, keyword)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

router.post('/search-posts', async (req, res, next) => {
  try {
    const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : ''
    const filter = typeof req.body?.filter === 'string' ? req.body.filter.trim() : 'live'

    if (!keyword) {
      return res.status(400).json({ message: 'A keyword is required.' })
    }

    const result = await captureTwitterSearchPosts(keyword, { filter })
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

router.post('/sync', async (req, res, next) => {
  try {
    const searches = Array.isArray(req.body?.searches) ? req.body.searches : defaultTwitterSurferQueries
    const filter = typeof req.body?.filter === 'string' ? req.body.filter.trim() : 'live'
    const result = await runTwitterSurfer({ searches, filter })
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

export default router
