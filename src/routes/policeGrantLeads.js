import { Router } from 'express'
import PoliceGrantLead from '../models/PoliceGrantLead.js'
import { surfPoliceGrantDatabase } from '../services/policeGrantSurf.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const leads = await PoliceGrantLead.find().sort({ opportunityScore: -1, updatedAt: -1 }).limit(50)
    res.json(leads)
  } catch (error) {
    next(error)
  }
})

router.post('/surf', async (req, res, next) => {
  try {
    const limit = Number(req.body?.limit || 10)
    const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : ''
    const excludeLeadIds = Array.isArray(req.body?.excludeLeadIds) ? req.body.excludeLeadIds : []
    const excludeAgencyKeys = Array.isArray(req.body?.excludeAgencyKeys) ? req.body.excludeAgencyKeys : []
    const result = await surfPoliceGrantDatabase({ limit, instructions, excludeLeadIds, excludeAgencyKeys })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

router.delete('/:leadId', async (req, res, next) => {
  try {
    const lead = await PoliceGrantLead.findOneAndDelete({ leadId: req.params.leadId })

    if (!lead) {
      return res.status(404).json({ message: 'Police grant lead was not found.' })
    }

    res.json({ lead })
  } catch (error) {
    next(error)
  }
})

export default router
