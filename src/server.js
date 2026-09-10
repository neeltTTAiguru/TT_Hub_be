import express from 'express'
import { failOrphanedRuns } from './services/contentOperations.js'
import { resumeRunOnBoot } from './services/researchRunner.js'
import cors from 'cors'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { corsOptions } from './config/corsOptions.js'
import {
  attachHermesDashboardUpgrade,
  createHermesDashboardMiddleware,
  createHermesSession,
  destroyHermesSession,
} from './services/hermesDashboard.js'
import { requireAuth } from './middleware/auth.js'
import { requireFeatureAccess } from './middleware/featureAccess.js'
import healthRouter from './routes/health.js'
import accessRouter from './routes/access.js'
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
import leAgenciesRouter from './routes/leAgencies.js'
import crmDealsRouter from './routes/crmDeals.js'
import grantSourcesRouter from './routes/grantSources.js'
import grantOpportunitiesRouter from './routes/grantOpportunities.js'
import linkedinSurferRouter from './routes/linkedinSurfer.js'
import twitterSurferRouter from './routes/twitterSurfer.js'
import usersRouter from './routes/users.js'
import adminRouter from './routes/admin.js'
import seoContentRouter from './routes/seoContent.js'
import companyFilesRouter from './routes/companyFiles.js'
import productImagesRouter from './routes/productImages.js'
import contentOperationsRouter from './routes/contentOperations.js'
import brevoRouter from './routes/brevo.js'
import emailAssetsRouter from './routes/emailAssets.js'
import contentOperationsDownloadsRouter from './routes/contentOperationsDownloads.js'
import { startCompetitorCollectorSchedule } from './services/competitorCollector.js'
import { startHubSpotHealthMonitor } from './services/hubspotHealth.js'

dotenv.config()

const app = express()
const port = process.env.PORT || 3000

/**
 * Proxy-only mode.
 *
 * The Orchestrator tab needs Hermes served from the HUB's origin, and a
 * DigitalOcean app can only path-route between components of the same app. So
 * this service is deployed a SECOND time, as a component of the frontend app,
 * purely to answer Hermes' paths.
 *
 * That second copy must not behave like the real API. Booting it normally would
 * start a second set of schedulers against the same database: two competitor
 * collectors, two HubSpot health monitors, and -- worst -- a second
 * `resumeRunOnBoot`, which picks up in-flight research runs that cost real money
 * per agency. It skips Mongo entirely too, since nothing it serves reads from
 * it.
 */
const hermesProxyOnly = /^(1|true|yes)$/i.test(String(process.env.HERMES_PROXY_ONLY || ''))
const mongoUri = process.env.MONGODB_URI || ''
const requestRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' && req.path === '/content-operations/runs',
})

app.disable('x-powered-by')

// Ahead of helmet, the rate limiter and the body parser, all three of which
// break a proxy:
//   - helmet's CSP would be left on the piped Hermes HTML (Hermes sends none of
//     its own) and kill its inline bootstrap;
//   - the 300-per-15-minutes limiter would throttle a dashboard that polls;
//   - express.json() drains the request stream, so a proxied POST would arrive
//     at Hermes with an empty body.
// It gates itself on a signed cookie and ignores every path it does not own.
const hermesDashboard = createHermesDashboardMiddleware()
app.use(hermesDashboard)

app.use(helmet())
app.use(cors(corsOptions))
app.use(requestRateLimit)
// Larger limit so chat requests can carry base64 attachments (images/PDFs).
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '25mb' }))

app.get('/', (_req, res) => {
  res.json({
    name: 'Trusted Tech Hub API',
    status: 'running',
  })
})

// A liveness probe is all the DigitalOcean health check needs, and it must not
// depend on Mongo -- which proxy-only mode never connects to.
app.get('/hermes-proxy/health', (_req, res) =>
  res.json({ ok: true, mode: hermesProxyOnly ? 'hermes-proxy-only' : 'full-api' }))

// Mints/clears the cookie the iframe travels on. Explicitly behind requireAuth:
// this is the one place in the Hermes flow where a bearer token is checked.
// OUTSIDE the guard below -- proxy-only mode exists to serve Hermes, and without
// this the frame could never get a session at all.
app.post('/hermes-session', requireAuth, createHermesSession)
app.delete('/hermes-session', requireAuth, destroyHermesSession)

if (!hermesProxyOnly) {
app.use('/health', healthRouter)
app.use('/content-operations-download', contentOperationsDownloadsRouter)
app.use('/email-assets', emailAssetsRouter)
app.use(requireAuth)
// Above the feature gate on purpose: this is how a restricted account finds
// out that it is restricted, so refusing it would leave the sidebar guessing.
app.use('/access', accessRouter)
app.use(requireFeatureAccess)
app.use('/agents', agentsRouter)
app.use('/rfp-opportunities', rfpOpportunitiesRouter)
app.use('/company-context', companyContextRouter)
app.use('/competitors', competitorsRouter)
app.use('/browser-research', browserResearchRouter)
app.use('/products', productsRouter)
app.use('/public-pages', publicPagesRouter)
app.use('/research-runs', researchRunsRouter)
app.use('/chat-threads', chatThreadsRouter)
app.use('/police-grant-leads', policeGrantLeadsRouter)
app.use('/le-agencies', leAgenciesRouter)
app.use('/crm-deals', crmDealsRouter)
app.use('/grant-sources', grantSourcesRouter)
app.use('/grant-opportunities', grantOpportunitiesRouter)
app.use('/linkedin-surfer', linkedinSurferRouter)
app.use('/twitter-surfer', twitterSurferRouter)
app.use('/users', usersRouter)
app.use('/admin', adminRouter)
app.use('/api/seo-content', seoContentRouter)
app.use('/company-files', companyFilesRouter)
app.use('/product-images', productImagesRouter)
app.use('/content-operations', contentOperationsRouter)
app.use('/brevo', brevoRouter)
}

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
  if (hermesProxyOnly) {
    console.log('HERMES_PROXY_ONLY: serving the Hermes dashboard proxy only — no Mongo, no schedulers.')
  } else if (!mongoUri) {
    console.warn('MONGODB_URI is not set. Skipping Mongo connection.')
  } else {
    await mongoose.connect(mongoUri)
    console.log('Connected to MongoDB')
  }

  const server = app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`)
    // None of this may run in proxy-only mode. That process is a second copy of
    // this service living in the frontend app, and every one of these is a
    // singleton against shared state: two collectors and two health monitors
    // would double up, and resumeRunOnBoot would pick up an in-flight research
    // run the REAL server is already executing — at real cost per agency.
    if (hermesProxyOnly) return
    // Only after the port is ours. A process that cannot bind is not the live server —
    // it may be a stale watcher about to exit on EADDRINUSE — and must never touch runs
    // the real server is actively executing.
    void failOrphanedRuns().catch((error) => console.error('Failed to release orphaned content runs', error))
    startCompetitorCollectorSchedule()
    startHubSpotHealthMonitor()
    // Same reasoning as above: a research run costs real money per agency, so
    // only the process that actually owns the port may pick one back up.
    void resumeRunOnBoot().catch((error) => console.error('Failed to resume research run', error))
  })

  // The chat terminal is a PTY over a websocket. Upgrades never reach Express,
  // so the proxy and its cookie gate are attached to the raw server.
  attachHermesDashboardUpgrade(server, hermesDashboard)

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
