import crypto from 'node:crypto'
import { getAhrefsResearch } from './ahrefsAdapter.js'
import { getSurferRecommendations } from './surferAdapter.js'
import { createBrief, createOutline, draftArticle, reviseArticle } from './stages.js'
import { parseSeoInput, slugify } from './schemas.js'
import { persistSeoJob } from './persistence.js'

const activeKeywords = new Set()
const log = (jobId, stage, status, extra = {}) => console.info(JSON.stringify({ event: 'seo_stage', job_id: jobId, stage, status, ...extra }))

export async function runSeoContentWorkflow(rawInput, dependencies = {}) {
  const input = parseSeoInput(rawInput)
  const duplicateKey = input.primary_keyword.toLowerCase()
  if (activeKeywords.has(duplicateKey)) throw Object.assign(new Error('A job for this keyword is already processing.'), { statusCode: 409 })
  activeKeywords.add(duplicateKey)
  const jobId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const run = async (stage, fn) => {
    log(jobId, stage, 'started')
    const result = await fn()
    log(jobId, stage, 'completed')
    return result
  }
  try {
    const research = await run('research', () => (dependencies.getResearch ?? getAhrefsResearch)(input))
    const seoBrief = await run('brief', () => (dependencies.createBrief ?? createBrief)(input, research))
    const outline = await run('outline', () => (dependencies.createOutline ?? createOutline)(input, seoBrief))
    const initialDraft = await run('draft', () => (dependencies.draftArticle ?? draftArticle)(input, seoBrief, outline))
    const surfer = await run('optimization', () => (dependencies.getSurfer ?? getSurferRecommendations)(input, initialDraft))
    const finalArticle = await run('revision', () => (dependencies.reviseArticle ?? reviseArticle)(input, seoBrief, initialDraft, surfer))
    const title = outline.title || outline.h1
    const job = {
      job_id: jobId, status: 'completed', input, research, seo_brief: seoBrief, outline,
      initial_draft: initialDraft, surfer_recommendations: surfer, final_article: finalArticle,
      metadata: {
        title, meta_title: title.slice(0, 60),
        meta_description: `Learn about ${input.primary_keyword}, planning considerations, and practical next steps.`.slice(0, 160),
        slug: slugify(title), primary_keyword: input.primary_keyword,
        secondary_keywords: seoBrief.secondary_keywords,
        estimated_word_count: finalArticle.split(/\s+/).filter(Boolean).length,
        source_needed_count: (finalArticle.match(/\[SOURCE NEEDED\]/g) || []).length,
      },
      created_at: createdAt, completed_at: new Date().toISOString(),
    }
    await run('persistence', () => (dependencies.persist ?? persistSeoJob)(job))
    return job
  } finally {
    activeKeywords.delete(duplicateKey)
  }
}
