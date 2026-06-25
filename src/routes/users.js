import express, { Router } from 'express'
import { getAuthenticatedUser } from '../middleware/auth.js'
import User from '../models/User.js'
import { generateUploadedGrantApplicationResponse } from '../services/grantApplicationDrafts.js'
import { extractGrantApplicationUpload } from '../services/grantApplicationUploads.js'

const router = Router()
const grantApplicationUploadParser = express.raw({ type: '*/*', limit: '10mb' })

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

router.post('/:id/grant-applications', grantApplicationUploadParser, async (req, res, next) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req)
    const fileName = decodeURIComponent(String(req.header('x-file-name') || 'grant-application-upload'))
      .replace(/[^\w.\- ()]/g, '')
      .trim()
      .slice(0, 160) || 'grant-application-upload'
    const contentType = String(req.header('content-type') || 'application/octet-stream')
    const extracted = await extractGrantApplicationUpload({
      buffer: req.body,
      fileName,
      contentType,
    })

    const upload = {
      fileName,
      contentType,
      sizeBytes: extracted.sizeBytes,
      extractedText: extracted.extractedText,
      truncated: extracted.truncated,
      uploadedAt: new Date(),
    }
    const user = await User.findOneAndUpdate(
      {
        _id: req.params.id,
        createdBy: authenticatedUser.id,
      },
      {
        $push: {
          uploadedGrantApplications: {
            $each: [upload],
            $position: 0,
            $slice: 12,
          },
        },
      },
      {
        new: true,
        runValidators: true,
      },
    )

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    return res.status(201).json(user)
  } catch (error) {
    return next(error)
  }
})

router.post('/:id/grant-applications/:uploadId/generate-response', async (req, res, next) => {
  try {
    const authenticatedUser = getAuthenticatedUser(req)
    const user = await User.findOne({
      _id: req.params.id,
      createdBy: authenticatedUser.id,
    })

    if (!user) {
      return res.status(404).json({ message: 'User not found' })
    }

    const result = await generateUploadedGrantApplicationResponse({
      user,
      uploadId: req.params.uploadId,
    })

    return res.status(201).json(result)
  } catch (error) {
    return next(error)
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
