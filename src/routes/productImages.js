import express, { Router } from 'express'
import { getAuthenticatedUser } from '../middleware/auth.js'
import {
  deleteProductImage,
  describeProductImage,
  listProductImages,
  readProductImage,
  saveProductImage,
  setReferenceImage,
} from '../services/productImages.js'

const router = Router()
// Same shape as the company-files upload: raw bytes with the name in a header,
// so no multipart parser is needed.
const uploadParser = express.raw({ type: '*/*', limit: '15mb' })

router.get('/', async (_req, res, next) => {
  try {
    return res.json(await listProductImages())
  } catch (error) {
    return next(error)
  }
})

// The bytes, for the thumbnails in the library. Cached only briefly: replacing
// an image keeps its name, so a long cache would show the old one.
router.get('/:name/raw', async (req, res, next) => {
  try {
    const { bytes, mimeType } = await readProductImage(req.params.name)
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Cache-Control', 'no-cache')
    return res.end(bytes)
  } catch (error) {
    return next(error)
  }
})

router.post('/', uploadParser, async (req, res, next) => {
  try {
    const fileName = String(req.header('x-file-name') || '').trim().slice(0, 200)
    const saved = await saveProductImage({ buffer: req.body, fileName, user: getAuthenticatedUser(req)?.email || '' })
    return res.status(saved.replaced ? 200 : 201).json(saved)
  } catch (error) {
    return next(error)
  }
})

router.post('/:name/description', express.json(), async (req, res, next) => {
  try {
    return res.json(await describeProductImage(req.params.name, req.body?.description))
  } catch (error) {
    return next(error)
  }
})

router.post('/:name/reference', async (req, res, next) => {
  try {
    return res.json(await setReferenceImage(req.params.name))
  } catch (error) {
    return next(error)
  }
})

router.delete('/:name', async (req, res, next) => {
  try {
    return res.json(await deleteProductImage(req.params.name))
  } catch (error) {
    return next(error)
  }
})

export default router
