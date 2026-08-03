import { Router } from 'express'
import { runSeoContentWorkflow } from '../seo/workflow.js'
import { readSeoJob } from '../seo/persistence.js'

const router = Router()
router.post('/generate', async (req, res, next) => {
  try { return res.status(201).json(await runSeoContentWorkflow(req.body)) } catch (error) { return next(error) }
})
router.get('/jobs/:jobId', async (req, res, next) => {
  try {
    const job = await readSeoJob(req.params.jobId)
    return job ? res.json(job) : res.status(404).json({ message: 'SEO content job not found' })
  } catch (error) { return next(error) }
})
export default router
