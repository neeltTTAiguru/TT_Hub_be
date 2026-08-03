import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeAhrefs, normalizeSurfer } from '../src/seo/normalizers.js'
import { validateOutline, validateSeoBrief } from '../src/seo/schemas.js'
import { generateValidated } from '../src/seo/llmClient.js'
import { getAhrefsResearch } from '../src/seo/ahrefsAdapter.js'
import { persistSeoJob, readSeoJob } from '../src/seo/persistence.js'
import { runSeoContentWorkflow } from '../src/seo/workflow.js'
import { mockAhrefs, mockSurfer } from '../src/seo/fixtures.js'
import { mockArticle, mockBrief, mockOutline } from '../src/seo/stages.js'

test('normalizes Ahrefs without inventing metrics', () => {
  const result = normalizeAhrefs({ related_keywords: ['one'] }, 'keyword')
  assert.equal(result.search_volume, null)
  assert.equal(result.keyword_difficulty, null)
  assert.deepEqual(result.related_keywords, ['one'])
})

test('normalizes Surfer variants and unavailable fields', () => {
  const result = normalizeSurfer({ contentScore: 72, terms: ['evidence'] })
  assert.equal(result.content_score, 72)
  assert.equal(result.recommended_word_count, null)
  assert.deepEqual(result.recommended_terms, ['evidence'])
})

test('SEO brief and outline validators reject malformed output', () => {
  assert.throws(() => validateSeoBrief({}), /missing/)
  assert.throws(() => validateOutline({}), /missing/)
})

test('missing Ahrefs credential is explicit', async () => {
  const originalKey = process.env.AHREFS_API_KEY
  const originalMock = process.env.SEO_USE_MOCK_AHREFS
  delete process.env.AHREFS_API_KEY
  delete process.env.SEO_USE_MOCK_AHREFS
  await assert.rejects(() => getAhrefsResearch({ primary_keyword: 'x' }), /AHREFS_API_KEY/)
  if (originalKey !== undefined) process.env.AHREFS_API_KEY = originalKey
  if (originalMock !== undefined) process.env.SEO_USE_MOCK_AHREFS = originalMock
})

test('Ahrefs mock mode works without credentials', async () => {
  const original = process.env.SEO_USE_MOCK_AHREFS
  process.env.SEO_USE_MOCK_AHREFS = 'true'
  const result = await getAhrefsResearch({ primary_keyword: 'police body camera grants' })
  assert.equal(result.source, 'ahrefs')
  if (original === undefined) delete process.env.SEO_USE_MOCK_AHREFS
  else process.env.SEO_USE_MOCK_AHREFS = original
})

test('malformed model output is retried once', async () => {
  const original = process.env.SEO_MAX_MODEL_RETRIES
  process.env.SEO_MAX_MODEL_RETRIES = '1'
  let calls = 0
  const value = await generateValidated({}, (parsed) => {
    if (!parsed.ok) throw new Error('bad')
    return parsed
  }, async () => JSON.stringify({ ok: ++calls > 1 }))
  assert.equal(calls, 2)
  assert.equal(value.ok, true)
  if (original === undefined) delete process.env.SEO_MAX_MODEL_RETRIES
  else process.env.SEO_MAX_MODEL_RETRIES = original
})

test('persistence saves and reads JSON and Markdown', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seo-content-'))
  const job = { job_id: '11111111-1111-4111-8111-111111111111', final_article: '# Test' }
  const files = await persistSeoJob(job, directory)
  assert.equal(await fs.readFile(files.markdown, 'utf8'), '# Test\n')
  assert.deepEqual(await readSeoJob(job.job_id, directory), job)
})

test('complete workflow succeeds with mocked external calls', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'seo-workflow-'))
  const input = { primary_keyword: 'police body camera grants', target_audience: ['police chiefs'] }
  const dependencies = {
    getResearch: async (parsed) => normalizeAhrefs(mockAhrefs, parsed.primary_keyword),
    createBrief: async (parsed, research) => mockBrief(parsed, research),
    createOutline: async (parsed, brief) => mockOutline(parsed, brief),
    draftArticle: async (parsed, _brief, outline) => mockArticle(parsed, outline),
    getSurfer: async () => normalizeSurfer(mockSurfer),
    reviseArticle: async (_input, _brief, article) => article,
    persist: async (job) => persistSeoJob(job, directory),
  }
  const result = await runSeoContentWorkflow(input, dependencies)
  assert.equal(result.status, 'completed')
  assert.match(result.final_article, /^# /)
  assert.equal((await readSeoJob(result.job_id, directory)).job_id, result.job_id)
})
