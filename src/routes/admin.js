import { Router } from 'express'
import { getAuthenticatedUser, resolveEmailFromUserInfo } from '../middleware/auth.js'
import User from '../models/User.js'

const router = Router()

function splitEnvList(value = '') {
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function isBootstrapAdmin(authenticatedUser) {
  const adminEmails = splitEnvList(process.env.ADMIN_EMAILS || 'neel@trustedtechnology.ai')
  const adminAuth0Ids = splitEnvList(process.env.ADMIN_AUTH0_IDS)
  const email = authenticatedUser.email.toLowerCase()
  const id = authenticatedUser.id.toLowerCase()

  return (email && adminEmails.includes(email)) || (id && adminAuth0Ids.includes(id))
}

async function requireAdmin(req, _res, next) {
  try {
    const authenticatedUser = getAuthenticatedUser(req)
    authenticatedUser.email ||= await resolveEmailFromUserInfo(req)

    if (isBootstrapAdmin(authenticatedUser)) {
      req.adminUser = authenticatedUser
      return next()
    }

    const bootstrapEmails = splitEnvList(process.env.ADMIN_EMAILS || 'neel@trustedtechnology.ai')

    if (bootstrapEmails.length) {
      const bootstrapProfile = await User.findOne({
        createdBy: authenticatedUser.id,
        email: { $in: bootstrapEmails },
        status: 'active',
      }).lean()

      if (bootstrapProfile) {
        await User.updateOne({ _id: bootstrapProfile._id }, { isAdmin: true })
        req.adminUser = authenticatedUser
        return next()
      }
    }

    const existingAdminCount = await User.countDocuments({ isAdmin: true, status: 'active' })

    if (existingAdminCount === 0 && bootstrapEmails.length) {
      const bootstrapProfile = await User.findOne({
        email: { $in: bootstrapEmails },
        status: 'active',
      }).lean()

      if (bootstrapProfile) {
        await User.updateOne(
          { _id: bootstrapProfile._id },
          {
            isAdmin: true,
            createdBy: bootstrapProfile.createdBy || authenticatedUser.id,
          },
        )
        req.adminUser = authenticatedUser
        return next()
      }
    }

    if (authenticatedUser.email) {
      const adminProfile = await User.findOne({
        email: authenticatedUser.email,
        isAdmin: true,
        status: 'active',
      }).lean()

      if (adminProfile) {
        req.adminUser = authenticatedUser
        return next()
      }
    }

    const ownedAdminProfile = await User.findOne({
      createdBy: authenticatedUser.id,
      isAdmin: true,
      status: 'active',
    }).lean()

    if (ownedAdminProfile) {
      req.adminUser = authenticatedUser
      return next()
    }

    const error = new Error('Admin access is restricted.')
    error.statusCode = 403
    throw error
  } catch (error) {
    return next(error)
  }
}

router.use(requireAdmin)

router.get('/access', (req, res) => {
  res.json({
    allowed: true,
    user: {
      id: req.adminUser.id,
      email: req.adminUser.email,
    },
  })
})

router.get('/users', async (_req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: -1 })
    res.json(users)
  } catch (error) {
    next(error)
  }
})

router.post('/users', async (req, res, next) => {
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

router.patch('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, req.body, {
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

export default router
