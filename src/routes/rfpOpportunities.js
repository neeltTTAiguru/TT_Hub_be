import { Router } from 'express'
import Opportunity from '../models/Opportunity.js'
import { readOpportunityAttachments } from '../services/samGovAttachments.js'
import { findFirstSamGovBrowserOpportunity, runSamGovBrowserSearch } from '../services/samGovBrowserSearch.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const opportunities = await Opportunity.find().sort({ postedDate: -1, updatedAt: -1 }).limit(50)
    res.json(opportunities)
  } catch (error) {
    next(error)
  }
})

router.get('/:noticeId', async (req, res, next) => {
  try {
    const noticeId = decodeURIComponent(req.params.noticeId || '').trim()
    const opportunity = await Opportunity.findOne({
      $or: [
        { noticeId },
        { solicitationNumber: noticeId },
      ],
    })

    if (!opportunity) {
      return res.status(404).json({ message: 'RFP opportunity was not found.' })
    }

    res.json(opportunity)
  } catch (error) {
    next(error)
  }
})

router.delete('/:noticeId', async (req, res, next) => {
  try {
    const noticeId = decodeURIComponent(req.params.noticeId || '').trim()
    const opportunity = await Opportunity.findOneAndDelete({
      $or: [
        { noticeId },
        { solicitationNumber: noticeId },
      ],
    })

    if (!opportunity) {
      return res.status(404).json({ message: 'RFP opportunity was not found.' })
    }

    res.json({ opportunity })
  } catch (error) {
    next(error)
  }
})

router.post('/browser-search', async (req, res, next) => {
  try {
    const result = await runSamGovBrowserSearch({
      daysBack: Number(req.body?.daysBack || 21),
      keywords: Array.isArray(req.body?.keywords) && req.body.keywords.length ? req.body.keywords : undefined,
      noticeTypes: Array.isArray(req.body?.noticeTypes) && req.body.noticeTypes.length ? req.body.noticeTypes : undefined,
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/browser-search/first', async (req, res, next) => {
  try {
    const result = await findFirstSamGovBrowserOpportunity({
      instructions:
        typeof req.body?.instructions === 'string' && req.body.instructions.trim()
          ? req.body.instructions.trim()
          : undefined,
      keyword: typeof req.body?.keyword === 'string' && req.body.keyword.trim() ? req.body.keyword.trim() : undefined,
      excludeNoticeIds: Array.isArray(req.body?.excludeNoticeIds) ? req.body.excludeNoticeIds : [],
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
})

router.post('/:noticeId/attachments/read', async (req, res, next) => {
  try {
    const result = await readOpportunityAttachments(req.params.noticeId)
    res.json(result)
  } catch (error) {
    next(error)
  }
})

export default router
