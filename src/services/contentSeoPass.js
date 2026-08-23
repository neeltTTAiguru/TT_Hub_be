import crypto from 'node:crypto'
import ContentOperationsRun from '../models/ContentOperationsRun.js'
import { optimizeArticleWithSurfer, prepareSurferForRun, registerRunController } from './contentOperations.js'
import { chatWithHermes } from './hermesChat.js'

// The chat writes an article with no run behind it, but every Surfer function
// speaks the run model. This mints one to carry the draft through the SEO pass,
// so the score, the passes and the revised article are all recorded in the place
// the rest of the pipeline already reads from.
function keywordFrom(article, title, supplied) {
  if (supplied) return supplied.slice(0, 300)
  // The writer emits a slug below the article's `---` rule; it is the closest
  // thing to a declared primary keyword that a chat draft carries.
  const slug = article.match(/^Slug:\s*(.+)$/m)?.[1]
    || article.match(/^Recommended slug:\s*(.+)$/m)?.[1]
  if (slug) return slug.trim().replace(/-/g, ' ').slice(0, 300)
  return String(title || '').trim().slice(0, 300)
}

export async function startSeoPassForDraft({ article, title = '', primaryKeyword = '', guidance = '' }) {
  const keyword = keywordFrom(article, title, primaryKeyword)
  if (!keyword) {
    throw Object.assign(
      new Error('No primary keyword could be determined. Add one, or give the article a title.'),
      { statusCode: 400 },
    )
  }

  const run = await ContentOperationsRun.create({
    runId: crypto.randomUUID(),
    targetDomain: process.env.CONTENT_OPS_TARGET_DOMAIN || 'trustedtechnology.ai',
    requestType: 'seo_pass',
    userInstructions: guidance || `SEO pass for "${title || keyword}"`,
    workflowMode: 'manual',
    researchOnly: false,
    article,
    brief: { proposedTitle: title, primaryKeyword: keyword },
    currentStage: 'surfer_setup',
    status: 'running',
  })

  // Fire and forget. Building guidelines alone polls for minutes, so the caller
  // is handed the run id and polls it rather than holding a request open.
  // Registered so Stop actually aborts the Surfer polling rather than only
  // marking the run stopped.
  const controller = new AbortController()
  const release = registerRunController(run.runId, controller)

  void (async () => {
    try {
      // Ahrefs first: confirm the keyword is worth targeting before Surfer spends
      // minutes analysing its SERP. Hermes carries the Ahrefs MCP tools, so the
      // check runs through it. A failure here is not fatal — the pass continues
      // on the derived keyword rather than stopping.
      run.currentStage = 'opportunity_research'
      await run.save()
      const ahrefsPrompt = `Use the Ahrefs tools to check the keyword "${keyword}" for trustedtechnology.ai. Report, in under 120 words: monthly search volume, keyword difficulty, and whether it is worth targeting. If a closely related keyword is clearly better, name it and say why. Do not write an article. If the Ahrefs tools are unavailable, say so plainly.`
      try {
        const { content } = await chatWithHermes(
          'content-operations-assistant',
          [{ role: 'user', content: ahrefsPrompt }],
        )
        run.stages.push({
          cycle: 0,
          stage: 'opportunity_research',
          status: 'complete',
          tool: 'Ahrefs MCP via Hermes',
          result: `Keyword checked: ${keyword}`,
          explanation: String(content || '').slice(0, 2000),
          output: keyword,
          completedAt: new Date().toISOString(),
        })
      } catch (ahrefsError) {
        run.stages.push({
          cycle: 0,
          stage: 'opportunity_research',
          status: 'skipped',
          tool: 'Ahrefs MCP via Hermes',
          result: 'The Ahrefs check could not be completed.',
          explanation: String(ahrefsError?.message || ahrefsError).slice(0, 500),
          output: keyword,
          completedAt: new Date().toISOString(),
        })
      }
      await run.save()

      await prepareSurferForRun(run, { signal: controller.signal })

      // Record what Surfer asked for against what the article actually is. A
      // draft several thousand words over its SERP target is the single most
      // common reason these read as padded, and it was previously invisible.
      const target = run.surferGuidelines?.targetWordCount
      if (target) {
        const words = String(run.article || '').trim().split(/\s+/).filter(Boolean).length
        run.stages.push({
          cycle: 0,
          stage: 'surfer_setup',
          status: 'complete',
          tool: 'SurferSEO guidelines',
          result: `Target ${target} words; draft is ${words}.`,
          explanation: words > target * 1.25
            ? `The draft is ${words} words against a SurferSEO target of ${target} for "${keyword}" — roughly ${Math.round((words / target - 1) * 100)}% over. The rewrite will cut toward the target.`
            : `The draft is ${words} words against a SurferSEO target of ${target} for "${keyword}".`,
          output: String(target),
          completedAt: new Date().toISOString(),
        })
        await run.save()
      }
      await optimizeArticleWithSurfer(run, { editorialGuidance: guidance, signal: controller.signal })
      run.status = 'completed'
      await run.save()
    } catch (error) {
      // A user-initiated stop is not a failure.
      run.status = error?.code === 'RUN_STOPPED' || controller.signal.aborted ? 'stopped' : 'error'
      const message = error?.message || String(error)
      if (!run.errors.includes(message)) run.errors.push(message)
      await run.save().catch(() => {})
    } finally {
      release()
    }
  })()

  return run
}
