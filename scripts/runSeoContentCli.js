import 'dotenv/config'
import fs from 'node:fs/promises'
import { runSeoContentWorkflow } from '../src/seo/workflow.js'

const args = process.argv.slice(2)
const valueAfter = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}
const keyword = valueAfter('--keyword')
if (!keyword) {
  console.error('Usage: npm run seo:generate -- --keyword "target keyword" [--company-context ./context.json]')
  process.exit(1)
}
const contextPath = valueAfter('--company-context')
const context = contextPath ? JSON.parse(await fs.readFile(contextPath, 'utf8')) : {}
const result = await runSeoContentWorkflow({ ...context, primary_keyword: keyword })
console.log(JSON.stringify({ job_id: result.job_id, status: result.status, metadata: result.metadata }, null, 2))
