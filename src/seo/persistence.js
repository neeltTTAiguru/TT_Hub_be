import fs from 'node:fs/promises'
import path from 'node:path'

export async function persistSeoJob(job, outputDir = process.env.SEO_OUTPUT_DIR || './data/seo-content') {
  const directory = path.resolve(outputDir)
  await fs.mkdir(directory, { recursive: true })
  const base = path.join(directory, job.job_id)
  await Promise.all([
    fs.writeFile(`${base}.json`, `${JSON.stringify(job, null, 2)}\n`, { flag: 'wx' }),
    fs.writeFile(`${base}.md`, `${job.final_article}\n`, { flag: 'wx' }),
  ])
  return { json: `${base}.json`, markdown: `${base}.md` }
}

export async function readSeoJob(jobId, outputDir = process.env.SEO_OUTPUT_DIR || './data/seo-content') {
  if (!/^[a-f0-9-]{36}$/.test(jobId)) return null
  try {
    return JSON.parse(await fs.readFile(path.resolve(outputDir, `${jobId}.json`), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
