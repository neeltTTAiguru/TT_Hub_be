import { Router } from 'express'
import GrantOpportunity from '../models/GrantOpportunity.js'
import { generateGrantApplicationDraft } from '../services/grantApplicationDrafts.js'
import { readGrantApplicationQuestions } from '../services/grantApplicationQuestions.js'
import { discoverGrantOpportunitiesForUser } from '../services/grantOpportunityDiscovery.js'
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

router.post('/discover', async (req, res, next) => {
  try {
    const result = await discoverGrantOpportunitiesForUser({
      state: typeof req.body?.state === 'string' ? req.body.state : '',
      stateCode: typeof req.body?.stateCode === 'string' ? req.body.stateCode : '',
      userProfile: req.body?.userProfile && typeof req.body.userProfile === 'object' ? req.body.userProfile : {},
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/:opportunityId/generate-response', async (req, res, next) => {
  try {
    const result = await generateGrantApplicationDraft({
      opportunityId: req.params.opportunityId,
      userId: req.body?.userId,
      applicationQuestions: req.body?.applicationQuestions && typeof req.body.applicationQuestions === 'object'
        ? req.body.applicationQuestions
        : null,
    })

    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/:opportunityId/read-application-questions', async (req, res, next) => {
  try {
    const result = await readGrantApplicationQuestions({
      opportunityId: req.params.opportunityId,
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
