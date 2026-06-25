import { runTwitterSurfer } from '../src/services/twitterSurfer.js'

const searches = process.env.SEARCHES
  ? process.env.SEARCHES.split('||').map((search) => search.trim()).filter(Boolean)
  : undefined
const filter = process.env.TWITTER_SEARCH_FILTER || 'live'

try {
  const result = await runTwitterSurfer({ searches, filter })
  console.log(
    JSON.stringify(
      {
        ok: true,
        searches: result.searches,
        filter: result.filter,
        postCount: result.posts.length,
        errors: result.errors,
        report: result.report,
        researchRunId: result.researchRun?._id ?? null,
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(JSON.stringify({ ok: false, statusCode: error?.statusCode || 500, message: error?.message }, null, 2))
  process.exitCode = 1
}
