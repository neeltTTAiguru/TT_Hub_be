import { Router } from 'express'
import GrantSource from '../models/GrantSource.js'

const router = Router()

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildStateQuery(stateParam) {
  const state = String(stateParam || '').trim()
  const stateCode = state.toUpperCase()

  if (!state) {
    return {}
  }

  return {
    $or: [
      { state: new RegExp(`^${escapeRegExp(state)}$`, 'i') },
      { stateCode },
    ],
  }
}

function buildListQuery(query) {
  const filters = {}

  if (typeof query.state === 'string' && query.state.trim()) {
    Object.assign(filters, buildStateQuery(query.state))
  }

  if (typeof query.category === 'string' && query.category.trim()) {
    filters.category = query.category.trim()
  }

  if (typeof query.focusArea === 'string' && query.focusArea.trim()) {
    filters.focusArea = query.focusArea.trim()
  }

  if (typeof query.isActive === 'string' && query.isActive.trim()) {
    filters.isActive = query.isActive.trim().toLowerCase() === 'true'
  }

  return filters
}

router.get('/', async (req, res, next) => {
  try {
    const sources = await GrantSource.find(buildListQuery(req.query)).sort({
      stateCode: 1,
      category: 1,
      focusArea: 1,
      sourceName: 1,
    })

    res.json(sources)
  } catch (error) {
    next(error)
  }
})

router.get('/state/:state', async (req, res, next) => {
  try {
    const sources = await GrantSource.find(buildStateQuery(req.params.state)).sort({
      category: 1,
      focusArea: 1,
      sourceName: 1,
    })

    res.json(sources)
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const source = await GrantSource.create(req.body)
    res.status(201).json(source)
  } catch (error) {
    next(error)
  }
})

router.patch('/:id', async (req, res, next) => {
  try {
    const source = await GrantSource.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    })

    if (!source) {
      return res.status(404).json({ message: 'Grant source was not found.' })
    }

    res.json(source)
  } catch (error) {
    next(error)
  }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const source = await GrantSource.findByIdAndDelete(req.params.id)

    if (!source) {
      return res.status(404).json({ message: 'Grant source was not found.' })
    }

    res.json({ source })
  } catch (error) {
    next(error)
  }
})

export default router
