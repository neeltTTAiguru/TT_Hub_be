import { Router } from 'express'
import ResearchRun from '../models/ResearchRun.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const runs = await ResearchRun.find().sort({ updatedAt: -1 })
    res.json(runs)
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const run = await ResearchRun.create(req.body)
    res.status(201).json(run)
  } catch (error) {
    next(error)
  }
})

router.get('/:id', async (req, res, next) => {
  try {
    const run = await ResearchRun.findById(req.params.id)

    if (!run) {
      return res.status(404).json({ message: 'Research run not found' })
    }

    return res.json(run)
  } catch (error) {
    return next(error)
  }
})

router.patch('/:id', async (req, res, next) => {
  try {
    const run = await ResearchRun.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    })

    if (!run) {
      return res.status(404).json({ message: 'Research run not found' })
    }

    return res.json(run)
  } catch (error) {
    return next(error)
  }
})

export default router
