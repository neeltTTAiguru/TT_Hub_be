import { Router } from 'express'
import CompanyContext from '../models/CompanyContext.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    let context = await CompanyContext.findOne().sort({ createdAt: 1 })

    if (!context) {
      context = await CompanyContext.create({
        companyName: 'Trusted Tech',
        activeProducts: ['Market Researcher'],
      })
    }

    res.json(context)
  } catch (error) {
    next(error)
  }
})

router.put('/', async (req, res, next) => {
  try {
    const update = req.body
    let context = await CompanyContext.findOne().sort({ createdAt: 1 })

    if (!context) {
      context = await CompanyContext.create(update)
    } else {
      Object.assign(context, update)
      await context.save()
    }

    res.json(context)
  } catch (error) {
    next(error)
  }
})

export default router
