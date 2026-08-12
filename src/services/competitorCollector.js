// Automated competitor intelligence collector. On a schedule, it visits every
// tracked competitor's website, extracts their BWC models/specs, and writes each
// into that competitor's GBrain brain section (idempotent, stable slugs). This
// replaces the manual per-competitor "Read website" action with a background job.

import { PUBLIC_SAFETY_COMPETITORS } from '../data/publicSafetyCompetitors.js'
import { researchCompetitorWebsite } from './competitorResearch.js'
import { saveCompetitorModelMemory } from './memoryGateway.js'

const SPEC_LABELS = {
  batteryLife: 'Battery life',
  resolution: 'Video resolution',
  storage: 'Onboard storage',
  fieldOfView: 'Field of view',
  preRecord: 'Pre-record buffer',
  durability: 'Durability / IP rating',
  weight: 'Weight / size',
  lowLight: 'Low-light / night',
  connectivity: 'Connectivity',
  activation: 'Activation',
  evidenceManagement: 'Evidence / DEMS',
  price: 'Price / licensing',
}

let running = false
let lastRun = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function getCollectorStatus() {
  return { running, lastRun }
}

function toSpecs(model) {
  const specs = {}
  for (const [key, label] of Object.entries(SPEC_LABELS)) {
    if (String(model?.[key] || '').trim()) specs[label] = model[key]
  }
  return specs
}

// Reads every competitor's site and writes their models into GBrain sections.
export async function refreshAllCompetitorSections({ onlySlugs = null } = {}) {
  if (running) return { skipped: true, reason: 'already-running' }
  running = true
  const startedAt = new Date().toISOString()
  const results = []
  const gapMs = Math.max(0, Number(process.env.COMPETITOR_COLLECTOR_SITE_GAP_MS || 1500))

  try {
    const targets = PUBLIC_SAFETY_COMPETITORS.filter((comp) => !onlySlugs || onlySlugs.includes(comp.slug))
    for (const comp of targets) {
      const entry = { competitor: comp.slug, models: 0, saved: 0, status: 'ok' }
      try {
        const research = await researchCompetitorWebsite(comp.slug)
        entry.models = research.models.length
        for (const model of research.models) {
          try {
            await saveCompetitorModelMemory({
              competitor: comp.slug,
              model: model.name,
              specs: toSpecs(model),
              notes: model.notes,
              source: model.source || research.pagesRead[0] || comp.website,
            })
            entry.saved += 1
          } catch (saveError) {
            entry.status = 'partial'
            entry.error = saveError?.message || String(saveError)
          }
        }
      } catch (error) {
        entry.status = 'failed'
        entry.error = error?.message || String(error)
      }
      results.push(entry)
      console.log(JSON.stringify({ event: 'competitor_collector_site', ...entry }))
      await sleep(gapMs)
    }
  } finally {
    running = false
    lastRun = {
      startedAt,
      finishedAt: new Date().toISOString(),
      sites: results.length,
      totalSaved: results.reduce((sum, entry) => sum + entry.saved, 0),
      failed: results.filter((entry) => entry.status === 'failed').length,
      results,
    }
    console.log(JSON.stringify({ event: 'competitor_collector_done', ...lastRun, results: undefined }))
  }
  return lastRun
}

// Starts the recurring schedule at server boot. Gated by env so it only runs
// where GBrain + OpenAI are configured (e.g. the deployed backend).
export function startCompetitorCollectorSchedule() {
  if (String(process.env.COMPETITOR_COLLECTOR_ENABLED || '').toLowerCase() !== 'true') {
    console.log('Competitor collector disabled (set COMPETITOR_COLLECTOR_ENABLED=true to enable).')
    return
  }
  const hours = Math.max(1, Number(process.env.COMPETITOR_COLLECTOR_INTERVAL_HOURS || 24))
  const intervalMs = hours * 60 * 60 * 1000
  const initialDelayMs = Math.max(0, Number(process.env.COMPETITOR_COLLECTOR_INITIAL_DELAY_MS || 60000))
  console.log(`Competitor collector enabled: every ${hours}h (first run in ${Math.round(initialDelayMs / 1000)}s).`)

  setTimeout(() => {
    refreshAllCompetitorSections().catch((error) => console.error('competitor collector run failed', error))
  }, initialDelayMs)

  const timer = setInterval(() => {
    refreshAllCompetitorSections().catch((error) => console.error('competitor collector run failed', error))
  }, intervalMs)
  timer.unref?.()
}
