import express from 'express'
import cors from 'cors'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { corsOptions } from './config/corsOptions.js'
import healthRouter from './routes/health.js'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000
const mongoUri = process.env.MONGODB_URI || ''

app.use(cors(corsOptions))
app.use(express.json())

app.get('/', (_req, res) => {
  res.json({
    name: 'beCRM API',
    status: 'running',
  })
})

app.use('/health', healthRouter)

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
