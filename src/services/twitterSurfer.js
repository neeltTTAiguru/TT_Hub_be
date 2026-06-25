import mongoose from 'mongoose'
import ResearchRun from '../models/ResearchRun.js'
import { captureTwitterSearchPosts } from './browserResearch.js'

export const defaultTwitterSurferQueries = [
  '"body worn camera" (rfp OR bid OR solicitation OR procurement) (police OR sheriff OR "public safety")',
  '"body camera" (grant OR funding OR purchase OR contract) (police OR sheriff OR "law enforcement")',
  '"digital evidence" ("body camera" OR BWC) (rfp OR bid OR procurement)',
  '"body camera" upgrade police department',
  '"body worn camera" city council purchase',
  '"body cameras" budget police',
  '"BWC" grant "law enforcement"',
  '"body camera" pilot program sheriff',
  '"body camera" contract awarded police',
  '"digital evidence" police funding',
]

const opportunityTerms = [
  'rfp',
  'bid',
  'solicitation',
  'procurement',
  'grant',
  'funding',
  'contract',
  'purchase',
  'vendor',
  'proposal',
]

const activeRuns = new Map()
const DEFAULT_RUN_INTERVAL_MS = Number(process.env.TWITTER_SURFER_RUN_INTERVAL_MS || 5 * 60 * 1000)
const MAX_RUN_DURATION_MINUTES = Number(process.env.TWITTER_SURFER_MAX_RUN_DURATION_MINUTES || 30)
const MIN_SEARCHES_PER_RUN = 10
const ignoredTaskWords = new Set([
  'find',
  'search',
  'look',
  'looking',
  'posts',
  'post',
  'tweets',
  'tweet',
  'twitter',
  'x',
  'about',
  'recent',
  'latest',
  'united',
  'states',
  'usa',
  'us',
  'america',
  'american',
  'all',
  'agency',
  'being',
  'bwcs',
  'intent',
  'over',
  'related',
  'state',
  'used',
  'using',
  'with',
  'from',
  'that',
  'this',
  'they',
  'want',
  'need',
  'needs',
  'should',
  'please',
  'surf',
  'monitor',
  'body',
  'worn',
  'body-worn',
  'camera',
  'cameras',
  'bwc',
  'rfp',
  'rfps',
  'bid',
  'bids',
  'solicitation',
  'solicitations',
  'procurement',
  'grant',
  'grants',
  'funding',
  'purchase',
  'contract',
  'contracts',
])

const stateNames = [
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'florida',
  'georgia',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'new hampshire',
  'new jersey',
  'new mexico',
  'new york',
  'north carolina',
  'north dakota',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'rhode island',
  'south carolina',
  'south dakota',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington',
  'west virginia',
  'wisconsin',
  'wyoming',
]

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function quoteTerm(value) {
  return `"${String(value).replace(/"/g, '').trim()}"`
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term))
}

function uniqueValues(values) {
  return [...new Set(values.map(compactWhitespace).filter(Boolean))]
}

function buildOrGroup(terms) {
  const values = uniqueValues(terms)

  if (values.length === 1) {
    return values[0]
  }

  return `(${values.join(' OR ')})`
}

function titleCase(value) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function inferGeography(task) {
  const text = compactWhitespace(task).toLowerCase()
  const state = stateNames.find((name) => text.includes(name))
  return state ? titleCase(state) : ''
}

function extractTaskKeywords(task) {
  return compactWhitespace(task)
    .toLowerCase()
    .replace(/["'“”‘’]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 3 && !ignoredTaskWords.has(word))
    .slice(0, 6)
}

function inferSearchPlan(task) {
  const normalizedTask = compactWhitespace(task)
  const text = normalizedTask.toLowerCase()
  const geography = inferGeography(normalizedTask)
  const bodyCameraTerms = hasAny(text, ['digital evidence', 'evidence management'])
    ? [quoteTerm('digital evidence'), quoteTerm('body camera'), 'BWC']
    : [quoteTerm('body worn camera'), quoteTerm('body-worn camera'), quoteTerm('body camera'), 'BWC']
  const buyerTerms = hasAny(text, ['city', 'municipal', 'council'])
    ? ['police', 'sheriff', quoteTerm('city council'), quoteTerm('public safety')]
    : ['police', 'sheriff', quoteTerm('law enforcement'), quoteTerm('public safety')]
  const procurementTerms = hasAny(text, ['grant', 'funding', 'fund'])
    ? ['grant', 'funding', 'purchase', 'contract']
    : ['RFP', 'bid', 'solicitation', 'procurement']
  const secondaryTerms = ['grant', 'funding', 'contract', 'purchase']
  const userKeywords = extractTaskKeywords(normalizedTask).filter(
    (keyword) =>
      ![
        'body',
        'worn',
        'camera',
        'cameras',
        'evidence',
        'digital',
        'police',
        'sheriff',
        'grant',
        'funding',
        geography.toLowerCase(),
      ].includes(keyword),
  )
  const userKeywordGroup = userKeywords.length ? buildOrGroup(userKeywords.slice(0, 4)) : ''

  return {
    bodyCameraTerms,
    buyerTerms,
    procurementTerms,
    secondaryTerms,
    userKeywordGroup,
    geography,
  }
}

function clampNumber(value, { min, max, fallback }) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(max, Math.max(min, parsed))
}

function buildSearchesFromTask(task) {
  const normalizedTask = compactWhitespace(task)

  if (!normalizedTask) {
    return defaultTwitterSurferQueries
  }

  const plan = inferSearchPlan(normalizedTask)
  const bodyCameraGroup = buildOrGroup(plan.bodyCameraTerms)
  const buyerGroup = buildOrGroup(plan.buyerTerms)
  const procurementGroup = buildOrGroup(plan.procurementTerms)
  const secondaryGroup = buildOrGroup(plan.secondaryTerms)
  const digitalEvidenceGroup = buildOrGroup([quoteTerm('digital evidence'), quoteTerm('evidence management')])
  const optionalKeywords = plan.userKeywordGroup ? ` ${plan.userKeywordGroup}` : ''
  const geographySuffix = plan.geography ? ` ${quoteTerm(plan.geography)}` : ''

  return uniqueValues([
    `${bodyCameraGroup} ${procurementGroup} ${buyerGroup}${geographySuffix}`,
    `${bodyCameraGroup} ${secondaryGroup} ${buyerGroup}${geographySuffix}`,
    `${digitalEvidenceGroup} ${bodyCameraGroup} ${procurementGroup}${geographySuffix}`,
    optionalKeywords ? `${bodyCameraGroup} ${optionalKeywords} ${procurementGroup}${geographySuffix}` : '',
    `${quoteTerm('body camera')} grant police${geographySuffix}`,
    `${quoteTerm('body worn camera')} grant sheriff${geographySuffix}`,
    `${quoteTerm('body camera')} funding ${quoteTerm('public safety')}${geographySuffix}`,
    `${quoteTerm('BWC')} grant ${quoteTerm('law enforcement')}${geographySuffix}`,
    `${quoteTerm('body camera')} ${quoteTerm('city council')} funding${geographySuffix}`,
    `${quoteTerm('body camera')} county sheriff grant${geographySuffix}`,
    `${quoteTerm('digital evidence')} police funding${geographySuffix}`,
    `${quoteTerm('body cameras')} purchase grant${geographySuffix}`,
    `${quoteTerm('body camera')} upgrade police department${geographySuffix}`,
    `${quoteTerm('body camera')} pilot program police${geographySuffix}`,
  ]).slice(0, MIN_SEARCHES_PER_RUN)
}

function scorePost(post) {
  const text = compactWhitespace(post.text).toLowerCase()
  const matchedTerms = opportunityTerms.filter((term) => text.includes(term))
  const hasBodyCameraLanguage =
    text.includes('body worn') || text.includes('body-worn') || text.includes('body camera') || text.includes('bwc')
  const hasPublicSafetyLanguage =
    text.includes('police') ||
    text.includes('sheriff') ||
    text.includes('law enforcement') ||
    text.includes('public safety')

  let score = matchedTerms.length
  if (hasBodyCameraLanguage) score += 2
  if (hasPublicSafetyLanguage) score += 1
  if (post.url) score += 1
  if (post.postedAt) score += 1

  return {
    score,
    matchedTerms,
    hasBodyCameraLanguage,
    hasPublicSafetyLanguage,
  }
}

function dedupePosts(results) {
  const seen = new Set()
  const posts = []

  results.forEach((result) => {
    result.posts.forEach((post) => {
      const key = post.url || compactWhitespace(post.text).toLowerCase()
      if (!key || seen.has(key)) return
      seen.add(key)
      posts.push({
        ...post,
        search: result.keyword,
        sourcePage: result.url,
        signal: scorePost(post),
      })
    })
  })

  return posts.sort((a, b) => b.signal.score - a.signal.score)
}

function buildReport({ searches, posts, errors, task = '' }) {
  const opportunitySignals = posts.filter((post) => post.signal.score >= 4).slice(0, 8)
  const weakSignals = posts.filter((post) => post.signal.score < 4).slice(0, 6)
  const sourcePosts = opportunitySignals.length ? opportunitySignals : posts.slice(0, 5)

  return {
    summary: `Twitter Surfer${task ? ` task: ${task}.` : ''} Ran ${searches.length} X/Twitter search${searches.length === 1 ? '' : 'es'} and captured ${posts.length} candidate body-worn camera signal${posts.length === 1 ? '' : 's'}. ${opportunitySignals.length} looked like stronger opportunity leads.`,
    opportunitySignals,
    weakSignals,
    findings: sourcePosts.map((post) => ({
      summary: compactWhitespace(post.text).slice(0, 500),
      implication:
        post.signal.score >= 4
          ? 'This post contains body-worn camera and opportunity language. Treat it as a lead and verify through the linked source or agency procurement channel.'
          : 'This is a weak social signal. It may be useful for watchlist building, but needs verification before sales or proposal follow-up.',
      confidence: post.signal.score >= 5 ? 'medium' : 'low',
      sources: [
        {
          label: post.author || post.handle || 'X/Twitter post',
          url: post.url || post.sourcePage,
          sourceType: 'twitter-post',
        },
      ],
    })),
    recommendedNextSteps: [
      'Open the strongest post links and verify whether an official solicitation, grant notice, or agency procurement page exists.',
      'Add recurring high-signal accounts to the Trusted Tech watchlist.',
      'Cross-check strong leads against SAM.gov and agency procurement portals before treating them as real opportunities.',
      ...(errors.length ? ['Review failed searches and confirm the OpenClaw browser profile is signed in to X/Twitter.'] : []),
    ],
  }
}

async function saveResearchRun({ searches, posts, errors, report, task = '', title = '' }) {
  if (mongoose.connection.readyState !== 1) {
    return null
  }

  return ResearchRun.create({
    title: title || 'Twitter Surfer: body-worn camera opportunity scan',
    objective: task || 'Monitor X/Twitter for United States body-worn camera opportunity signals.',
    scope: `Searches run: ${searches.join(' | ')}`,
    status: 'completed',
    requestedBy: 'twitter-surfer',
    findings: report.findings,
    recommendedNextSteps: report.recommendedNextSteps,
    reportSummary: [
      report.summary,
      errors.length ? `Search errors: ${errors.map((error) => `${error.search}: ${error.message}`).join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  })
}

export async function runTwitterSurfer({ searches = defaultTwitterSurferQueries, filter = 'live', save = true, task = '' } = {}) {
  const normalizedSearches = searches.map(compactWhitespace).filter(Boolean)

  if (!normalizedSearches.length) {
    const error = new Error('Provide at least one Twitter/X search query.')
    error.statusCode = 400
    throw error
  }

  const results = []
  const errors = []

  for (const search of normalizedSearches) {
    try {
      results.push(await captureTwitterSearchPosts(search, { filter }))
    } catch (error) {
      errors.push({
        search,
        message: error instanceof Error ? error.message : 'Search failed.',
      })
    }
  }

  if (!results.length && errors.length) {
    const error = new Error(errors.map((entry) => `${entry.search}: ${entry.message}`).join(' | '))
    error.statusCode = 502
    throw error
  }

  const posts = dedupePosts(results)
  const report = buildReport({ searches: normalizedSearches, posts, errors, task })
  const researchRun = save ? await saveResearchRun({ searches: normalizedSearches, posts, errors, report, task }) : null

  return {
    searches: normalizedSearches,
    filter,
    posts,
    errors,
    report,
    researchRun,
  }
}

function mergePosts(existingPosts, nextPosts) {
  const byKey = new Map()

  existingPosts.forEach((post) => {
    byKey.set(post.url || compactWhitespace(post.text).toLowerCase(), post)
  })
  nextPosts.forEach((post) => {
    byKey.set(post.url || compactWhitespace(post.text).toLowerCase(), post)
  })

  return Array.from(byKey.values()).sort((left, right) => right.signal.score - left.signal.score)
}

function publicRun(run) {
  return {
    id: run.id,
    title: run.title,
    task: run.task,
    status: run.status,
    durationMinutes: run.durationMinutes,
    startedAt: run.startedAt,
    endsAt: run.endsAt,
    completedAt: run.completedAt,
    searches: run.searches,
    posts: run.posts,
    errors: run.errors,
    report: run.report,
    researchRun: run.researchRun,
    progress: run.progress,
    stoppedByUser: run.stoppedByUser,
  }
}

async function executeRunRound(run) {
  if (run.status !== 'running') return

  run.progress.roundsAttempted += 1

  try {
    const result = await runTwitterSurfer({
      searches: run.searches,
      filter: run.filter,
      save: false,
      task: run.task,
    })

    if (run.status !== 'running') return

    run.posts = mergePosts(run.posts, result.posts)
    run.errors = [...run.errors, ...result.errors]
    run.report = buildReport({ searches: run.searches, posts: run.posts, errors: run.errors, task: run.task })
    run.progress.lastRoundAt = new Date().toISOString()
  } catch (error) {
    run.errors.push({
      search: run.searches.join(' | '),
      message: error instanceof Error ? error.message : 'Twitter Surfer round failed.',
    })
  }
}

async function finishRun(run) {
  if (run.status !== 'running') return

  run.status = 'completed'
  run.completedAt = new Date().toISOString()
  run.report = buildReport({ searches: run.searches, posts: run.posts, errors: run.errors, task: run.task })
  run.researchRun = await saveResearchRun({
    searches: run.searches,
    posts: run.posts,
    errors: run.errors,
    report: run.report,
    task: run.task,
    title: run.title,
  })
}

export async function stopTwitterSurferTaskRun(runId) {
  const run = activeRuns.get(runId)

  if (!run) {
    return null
  }

  if (run.timer) {
    clearTimeout(run.timer)
    run.timer = null
  }

  if (run.status === 'running') {
    run.stoppedByUser = true
    await finishRun(run)
  }

  return publicRun(run)
}

async function runLoop(runId) {
  const run = activeRuns.get(runId)
  if (!run || run.status !== 'running') return

  await executeRunRound(run)

  if (run.status !== 'running') return

  if (Date.now() >= new Date(run.endsAt).getTime()) {
    await finishRun(run)
    return
  }

  run.timer = setTimeout(() => {
    void runLoop(runId)
  }, run.intervalMs)

  run.timer.unref?.()
}

export function listTwitterSurferTaskRuns() {
  return Array.from(activeRuns.values())
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    .map(publicRun)
}

export function getTwitterSurferTaskRun(runId) {
  const run = activeRuns.get(runId)
  return run ? publicRun(run) : null
}

export function startTwitterSurferTaskRun({ task, durationMinutes = 30, filter = 'live' }) {
  const normalizedTask = compactWhitespace(task)

  if (!normalizedTask) {
    const error = new Error('Describe what posts OpenClaw should search for.')
    error.statusCode = 400
    throw error
  }

  const safeDurationMinutes = clampNumber(durationMinutes, {
    min: 1,
    max: MAX_RUN_DURATION_MINUTES,
    fallback: 30,
  })
  const now = new Date()
  const id = `twitter-run-${now.getTime()}`
  const run = {
    id,
    title: `Twitter Surfer Run: ${normalizedTask.slice(0, 72)}`,
    task: normalizedTask,
    status: 'running',
    durationMinutes: safeDurationMinutes,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + safeDurationMinutes * 60 * 1000).toISOString(),
    completedAt: '',
    searches: buildSearchesFromTask(normalizedTask),
    filter,
    posts: [],
    errors: [],
    report: buildReport({ searches: buildSearchesFromTask(normalizedTask), posts: [], errors: [], task: normalizedTask }),
    researchRun: null,
    stoppedByUser: false,
    progress: {
      roundsAttempted: 0,
      lastRoundAt: '',
    },
    intervalMs: Math.min(DEFAULT_RUN_INTERVAL_MS, safeDurationMinutes * 60 * 1000),
    timer: null,
  }

  activeRuns.set(id, run)
  void runLoop(id)

  return publicRun(run)
}
