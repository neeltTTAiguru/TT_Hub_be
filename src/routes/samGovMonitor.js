import { Router } from 'express'
import Opportunity from '../models/Opportunity.js'
import { runSamGovMonitor } from '../services/samGovMonitor.js'

const router = Router()

router.get('/opportunities', async (_req, res, next) => {
  try {
    const opportunities = await Opportunity.find().sort({ postedDate: -1, updatedAt: -1 }).limit(50)
    res.json(opportunities)
  } catch (error) {
    next(error)
  }
})

router.post('/sync', async (_req, res, next) => {
  try {
    const result = await runSamGovMonitor()
    res.json(result)
  } catch (error) {
    next(error)
  }
})

export default router
