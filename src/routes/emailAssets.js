import { Router } from 'express'
import EmailAsset from '../models/EmailAsset.js'

const router = Router()

// Public on purpose: mail clients fetch these with no session. Ids are Mongo
// ObjectIds, and the collection holds only campaign imagery.
router.get('/:assetId', async (req, res, next) => {
  try {
    const asset = await EmailAsset.findById(req.params.assetId).select('+data')
    if (!asset) return res.status(404).json({ message: 'Image not found.' })
    res.set({
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    })
    return res.send(asset.data)
  } catch (error) {
    return next(error)
  }
})

export default router
