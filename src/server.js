import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { corsOptions } from './config/corsOptions.js'
import { requireAuth } from './middleware/auth.js'
import healthRouter from './routes/health.js'
import agentsRouter from './routes/agents.js'
import companyContextRouter from './routes/companyContext.js'
import competitorsRouter from './routes/competitors.js'
import browserResearchRouter from './routes/browserResearch.js'
import productsRouter from './routes/products.js'
import publicPagesRouter from './routes/publicPages.js'
import researchRunsRouter from './routes/researchRuns.js'
import chatThreadsRouter from './routes/chatThreads.js'
import rfpOpportunitiesRouter from './routes/rfpOpportunities.js'
import policeGrantLeadsRouter from './routes/policeGrantLeads.js'
import grantSourcesRouter from './routes/grantSources.js'
import grantOpportunitiesRouter from './routes/grantOpportunities.js'
import linkedinSurferRouter from './routes/linkedinSurfer.js'
import twitterSurferRouter from './routes/twitterSurfer.js'
import usersRouter from './routes/users.js'
import adminRouter from './routes/admin.js'
import seoContentRouter from './routes/seoContent.js'
import contentOperationsRouter from './routes/contentOperations.js'
import contentOperationsDownloadsRouter from './routes/contentOperationsDownloads.js'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000
const mongoUri = process.env.MONGODB_URI || ''
const requestRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' && req.path === '/content-operations/runs',
})

app.disable('x-powered-by')
app.use(helmet())
app.use(cors(corsOptions))
app.use(requestRateLimit)
app.use(express.json({ limit: '1mb' }))

app.get('/', (_req, res) => {
  res.json({
    name: 'Trusted Tech Hub API',
    status: 'running',
  })
})

app.use('/health', healthRouter)
app.use('/rfp-opportunities', rfpOpportunitiesRouter)
app.use('/content-operations-download', contentOperationsDownloadsRouter)
app.use(requireAuth)
app.use('/agents', agentsRouter)
app.use('/company-context', companyContextRouter)
app.use('/competitors', competitorsRouter)
app.use('/browser-research', browserResearchRouter)
app.use('/products', productsRouter)
app.use('/public-pages', publicPagesRouter)
app.use('/research-runs', researchRunsRouter)
app.use('/chat-threads', chatThreadsRouter)
app.use('/police-grant-leads', policeGrantLeadsRouter)
app.use('/grant-sources', grantSourcesRouter)
app.use('/grant-opportunities', grantOpportunitiesRouter)
app.use('/linkedin-surfer', linkedinSurferRouter)
app.use('/twitter-surfer', twitterSurferRouter)
app.use('/users', usersRouter)
app.use('/admin', adminRouter)
app.use('/api/seo-content', seoContentRouter)
app.use('/content-operations', contentOperationsRouter)

app.use((err, _req, res, _next) => {
  if (typeof err?.statusCode === 'number') {
    return res.status(err.statusCode).json({ message: err.message || 'Request failed' })
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: Object.values(err.errors).map((detail) => detail.message),
    })
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ message: 'Invalid resource id' })
  }

  if (err?.code === 11000) {
    const fields = Object.keys(err.keyPattern || err.keyValue || {})
    return res.status(409).json({
      message: fields.length
        ? `A record already exists with the same ${fields.join(', ')}.`
        : 'A record already exists with the same unique value.',
    })
  }

  console.error(err)
  return res.status(500).json({ message: 'Internal server error' })
})

async function start() {
  if (!mongoUri) {
    console.warn('MONGODB_URI is not set. Skipping Mongo connection.')
  } else {
    await mongoose.connect(mongoUri)
    console.log('Connected to MongoDB')
  }

  const server = app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`)
  })

  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Stop the existing server or run with PORT=<another-port> npm run dev.`)
      process.exit(1)
    }

    console.error('Server failed after startup', error)
    process.exit(1)
  })
}

start().catch((err) => {
  console.error('Failed to start server', err)
  process.exit(1)
})
