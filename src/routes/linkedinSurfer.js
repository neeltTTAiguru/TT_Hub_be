import { Router } from 'express'
import PublicPage from '../models/PublicPage.js'
import {
  captureLinkedInKeywordPosts,
  captureLinkedInSearchPosts,
  capturePublicPage,
  saveCapturedPublicPage,
} from '../services/browserResearch.js'

const router = Router()

router.get('/profiles', async (_req, res, next) => {
  try {
    const profiles = await PublicPage.find({ pageType: 'linkedin-profile' }).sort({ updatedAt: -1 }).limit(50)
    res.json(profiles)
  } catch (error) {
    next(error)
  }
})

router.post('/capture-profile', async (req, res, next) => {
  try {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''

    if (!url) {
      return res.status(400).json({ message: 'A LinkedIn profile URL is required.' })
    }

    const page = await capturePublicPage(url)
    const savedProfile = await saveCapturedPublicPage(page, {
      pageType: 'linkedin-profile',
      slug: `linkedin-${new URL(page.url).pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'profile'}`,
    })

    return res.json(savedProfile)
  } catch (error) {
    return next(error)
  }
})

router.post('/capture-posts', async (req, res, next) => {
  try {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
    const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : ''

    if (!url) {
      return res.status(400).json({ message: 'A LinkedIn page URL is required.' })
    }

    if (!keyword) {
      return res.status(400).json({ message: 'A keyword is required.' })
    }

    const result = await captureLinkedInKeywordPosts(url, keyword)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

router.post('/search-posts', async (req, res, next) => {
  try {
    const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : ''

    if (!keyword) {
      return res.status(400).json({ message: 'A keyword is required.' })
    }

    const result = await captureLinkedInSearchPosts(keyword)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

export default router
