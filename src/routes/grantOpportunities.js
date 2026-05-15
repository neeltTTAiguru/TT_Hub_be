import { Router } from 'express'
import GrantOpportunity from '../models/GrantOpportunity.js'
import { searchGrantOpportunities } from '../services/grantOpportunitySearch.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const opportunities = await GrantOpportunity.find().sort({ fitScore: -1, updatedAt: -1 }).limit(75)
    res.json(opportunities)
  } catch (error) {
    next(error)
  }
})

router.post('/search', async (req, res, next) => {
  try {
    const result = await searchGrantOpportunities({
      limit: Number(req.body?.limit || 12),
      keywords: Array.isArray(req.body?.keywords) ? req.body.keywords : [],
      state: typeof req.body?.state === 'string' ? req.body.state : '',
      agencyType: typeof req.body?.agencyType === 'string' ? req.body.agencyType : '',
      projectType: typeof req.body?.projectType === 'string' ? req.body.projectType : '',
      sourceUrls: Array.isArray(req.body?.sourceUrls) ? req.body.sourceUrls : [],
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
})

router.delete('/:opportunityId', async (req, res, next) => {
  try {
    const opportunity = await GrantOpportunity.findOneAndDelete({ opportunityId: req.params.opportunityId })

    if (!opportunity) {
      return res.status(404).json({ message: 'Grant opportunity was not found.' })
    }

    res.json({ opportunity })
  } catch (error) {
    next(error)
  }
})

export default router
