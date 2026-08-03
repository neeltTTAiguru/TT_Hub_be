import 'dotenv/config'
import { getWordPressDraft, trashWordPressDraft } from '../src/services/wordpress.js'

const ids = process.argv.slice(2)
if (!ids.length) throw new Error('Usage: node scripts/trashWordPressDrafts.js DRAFT_ID [...]')

const results = []
for (const id of ids) {
  const draft = await getWordPressDraft(id)
  const trashed = await trashWordPressDraft(draft)
  results.push({ id: trashed.id, type: draft.type, previousStatus: draft.status, status: trashed.status })
}
console.log(JSON.stringify(results))
