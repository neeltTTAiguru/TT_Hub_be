import { Router } from 'express'
import Competitor from '../models/Competitor.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const competitors = await Competitor.find().sort({ updatedAt: -1 })
    res.json(competitors)
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const competitor = await Competitor.create(req.body)
    res.status(201).json(competitor)
  } catch (error) {
    next(error)
  }
})

export default router
