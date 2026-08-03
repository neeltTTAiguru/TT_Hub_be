import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import mongoose from 'mongoose'
import ArticleAsset from '../src/models/ArticleAsset.js'
import ContentOperationsRun from '../src/models/ContentOperationsRun.js'

const [slug, sourcePath, role = 'hero'] = process.argv.slice(2)
if (!slug || !sourcePath) {
  throw new Error('Usage: node scripts/attachArticleImage.js <article-slug> <image-path> [hero|inline]')
}

const run = await (async () => {
  await mongoose.connect(process.env.MONGODB_URI)
  return ContentOperationsRun.findOne({
    'testPublication.slug': slug,
    'testPublication.published': true,
  }).lean()
})()

try {
  if (!run) throw new Error(`Published article not found for slug: ${slug}`)
  const data = await fs.readFile(sourcePath)
  const extension = path.extname(sourcePath).toLowerCase()
  const mimeType = extension === '.png' ? 'image/png'
    : extension === '.webp' ? 'image/webp'
      : 'image/jpeg'
  const sha256 = crypto.createHash('sha256').update(data).digest('hex')
  const asset = await ArticleAsset.findOneAndUpdate(
    { runId: run.runId, role },
    {
      runId: run.runId,
      role,
      filename: path.basename(sourcePath),
      mimeType,
      sizeBytes: data.length,
      sha256,
      altText: 'Front view of the Trusted Tech T500 body-worn camera.',
      caption: 'Trusted Tech T500 body-worn camera.',
      data,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
  console.log(JSON.stringify({
    assetId: asset._id,
    runId: run.runId,
    slug,
    role,
    mimeType,
    sizeBytes: data.length,
    sha256,
  }))
} finally {
  await mongoose.disconnect()
}
