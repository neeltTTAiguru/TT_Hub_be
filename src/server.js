import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { corsOptions } from './config/corsOptions.js'
import healthRouter from './routes/health.js'
import agentsRouter from './routes/agents.js'
import companyContextRouter from './routes/companyContext.js'
import competitorsRouter from './routes/competitors.js'
import researchRunsRouter from './routes/researchRuns.js'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000
const mongoUri = process.env.MONGODB_URI || ''

app.use(cors(corsOptions))
app.use(express.json())

app.get('/', (_req, res) => {
  res.json({
    name: 'Trusted Tech Hub API',
    status: 'running',
  })
})

app.use('/health', healthRouter)
app.use('/agents', agentsRouter)
app.use('/company-context', companyContextRouter)
app.use('/competitors', competitorsRouter)
app.use('/research-runs', researchRunsRouter)

app.use((err, _req, res, _next) => {
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: Object.values(err.errors).map((detail) => detail.message),
    })
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ message: 'Invalid resource id' })
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

  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`)
  })
}

start().catch((err) => {
  console.error('Failed to start server', err)
  process.exit(1)
})
