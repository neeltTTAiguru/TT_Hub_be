import express, { Router } from 'express'
import { deleteCompanyFile, listCompanyFiles, saveCompanyFile } from '../services/companyFiles.js'
import { getAuthenticatedUser } from '../middleware/auth.js'
import { ingestDocumentToBrain } from '../services/brainIngest.js'

const router = Router()
// Same shape as the grant-application upload: the browser posts raw bytes and
// names the file in a header, so no multipart parser is needed.
const uploadParser = express.raw({ type: '*/*', limit: '25mb' })

router.get('/', async (_req, res, next) => {
  try {
    return res.json(await listCompanyFiles())
  } catch (error) {
    return next(error)
  }
})

router.post('/', uploadParser, async (req, res, next) => {
  try {
    const user = getAuthenticatedUser(req)
    const fileName = String(req.header('x-file-name') || '').trim().slice(0, 200) || 'company-file'
    const title = String(req.header('x-file-title') || '').trim().slice(0, 200)
    const contentType = String(req.header('x-file-type') || 'application/octet-stream')
    const { document, replaced } = await saveCompanyFile({
      buffer: req.body,
      fileName,
      contentType,
      title,
      user,
    })
    return res.status(replaced ? 200 : 201).json({
      id: String(document._id),
      title: document.title,
      pageCount: document.pageCount,
      sizeBytes: document.sizeBytes,
      replaced,
    })
  } catch (error) {
    return next(error)
  }
})

// Splits an uploaded document into brain pages so every agent can retrieve it.
// Re-running overwrites the same slugs, so a corrected file replaces its pages
// rather than duplicating them.
router.post('/:id/ingest', async (req, res, next) => {
  try {
    const sensitivity = req.body?.sensitivity === 'public' ? 'public' : 'internal'
    const result = await ingestDocumentToBrain({ documentId: req.params.id, sensitivity })
    return res.status(201).json(result)
  } catch (error) {
    return next(error)
  }
})

router.delete('/:id', async (req, res, next) => {
  try {
    return res.json(await deleteCompanyFile(req.params.id))
  } catch (error) {
    return next(error)
  }
})

export default router
