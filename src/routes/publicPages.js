import { Router } from 'express'
import PublicPage from '../models/PublicPage.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const pages = await PublicPage.find().sort({ updatedAt: -1 })
    res.json(pages)
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const page = await PublicPage.create(req.body)
    res.status(201).json(page)
  } catch (error) {
    next(error)
  }
})

export default router
