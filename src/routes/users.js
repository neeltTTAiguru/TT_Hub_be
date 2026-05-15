import { Router } from 'express'
import { getAuthenticatedUser } from '../middleware/auth.js'
import User from '../models/User.js'

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req)
    const users = await User.find({ createdBy: authenticatedUser.id }).sort({ createdAt: -1 })
    res.json(users)
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req)
    const user = await User.create({
      ...req.body,
      createdBy: authenticatedUser.id,
    })
    res.status(201).json(user)
  } catch (error) {
    next(error)
  }
})

router.patch('/:id', async (req, res, next) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req)
    const user = await User.findOneAndUpdate({
      _id: req.params.id,
      createdBy: authenticatedUser.id,
    }, req.body, {
      new: true,
      runValidators: true,
    })

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    return res.json(user)
  } catch (error) {
    return next(error)
  }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req)
    const user = await User.findOneAndDelete({
      _id: req.params.id,
      createdBy: authenticatedUser.id,
    })

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    return res.json({ user })
  } catch (error) {
    return next(error)
  }
})

export default router
