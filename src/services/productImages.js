// The approved product photography the article image generator works from.
//
// Bytes live in Mongo, not on disk. The app runs from a container whose
// filesystem is rebuilt on every deploy, so an uploaded photo written to
// assets/article-images would survive locally and quietly disappear in
// production. The committed files in that folder are still the starting set —
// they seed the library the first time it is read — but everything after that
// is a database row.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ProductImage from '../models/ProductImage.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
export const SEED_DIR = path.resolve(moduleDir, '../../assets/article-images')
const SEED_REFERENCE = 't500-camera-reference.png'

const MAX_BYTES = 15 * 1024 * 1024
const ALLOWED = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

export function mimeForImage(filePath) {
  return ALLOWED[path.extname(filePath).toLowerCase()] || 'image/png'
}

// Upload names come from a browser and are not to be trusted as paths. basename
// strips any directory part, so nothing can be written outside the library.
function safeName(value) {
  const base = path.basename(String(value || '').trim())
  if (!base || base.startsWith('.')) return ''
  if (!(path.extname(base).toLowerCase() in ALLOWED)) return ''
  return base.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120)
}

// A lean() read hands back BSON Binary rather than a Node Buffer, and
// Buffer.from() on one of those yields nothing — an empty reference the image
// API accepts without complaint, producing artwork with no device in it. Both
// shapes are unwrapped here.
function toBuffer(value) {
  if (!value) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return value
  if (value.buffer) return Buffer.from(value.buffer)
  return Buffer.from(value)
}

// Runs once, when the library is empty: copies the committed images in so a
// fresh environment starts with the approved set rather than nothing.
async function seedFromDisk() {
  if (await ProductImage.estimatedDocumentCount()) return
  let names = []
  try {
    names = await fs.readdir(SEED_DIR)
  } catch {
    return
  }
  for (const name of names) {
    const safe = safeName(name)
    if (!safe) continue
    const bytes = await fs.readFile(path.join(SEED_DIR, safe)).catch(() => null)
    if (!bytes?.length) continue
    await ProductImage.updateOne(
      { name: safe },
      {
        $setOnInsert: {
          name: safe,
          mimeType: mimeForImage(safe),
          sizeBytes: bytes.length,
          data: bytes,
          isReference: safe === SEED_REFERENCE,
        },
      },
      { upsert: true },
    ).catch(() => {})
  }
}

export async function listProductImages() {
  await seedFromDisk()
  const rows = await ProductImage.find({}, 'name mimeType sizeBytes isReference description updatedAt').sort({ name: 1 }).lean()
  return {
    images: rows.map((row) => ({
      name: row.name,
      sizeBytes: row.sizeBytes,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : '',
      isReference: Boolean(row.isReference),
      description: row.description || '',
    })),
    reference: rows.find((row) => row.isReference)?.name || '',
  }
}

export async function readProductImage(name) {
  const safe = safeName(name)
  if (!safe) throw Object.assign(new Error('That is not an approved image name.'), { statusCode: 400 })
  await seedFromDisk()
  const row = await ProductImage.findOne({ name: safe }).select('+data').lean()
  const bytes = toBuffer(row?.data)
  if (!bytes.length) throw Object.assign(new Error('That image does not exist.'), { statusCode: 404 })
  return { bytes, mimeType: row.mimeType || mimeForImage(safe) }
}

// What the generator builds the device from. Falls back to the committed file so
// artwork still works if the library has not been reached yet.
export async function resolveReference() {
  await seedFromDisk().catch(() => {})
  const row = await ProductImage.findOne({ isReference: true }).select('+data').lean().catch(() => null)
  const bytes = toBuffer(row?.data)
  if (bytes.length) return { bytes, mimeType: row.mimeType || 'image/png', name: row.name }
  const fallback = path.join(SEED_DIR, SEED_REFERENCE)
  return { bytes: await fs.readFile(fallback), mimeType: mimeForImage(fallback), name: SEED_REFERENCE }
}

export async function saveProductImage({ buffer, fileName, user = '' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error('The upload was empty.'), { statusCode: 400 })
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('That image is larger than 15MB.'), { statusCode: 413 })
  }
  const safe = safeName(fileName)
  if (!safe) {
    throw Object.assign(new Error('Only PNG, JPEG and WebP images can be approved.'), { statusCode: 400 })
  }
  await seedFromDisk()
  const existing = await ProductImage.findOne({ name: safe }).lean()
  await ProductImage.updateOne(
    { name: safe },
    {
      $set: {
        name: safe,
        mimeType: mimeForImage(safe),
        sizeBytes: buffer.length,
        data: buffer,
        uploadedBy: String(user || ''),
      },
      // A first upload into an empty library becomes the reference, so artwork
      // is never left with nothing to work from.
      $setOnInsert: { isReference: !(await ProductImage.exists({ isReference: true })) },
    },
    { upsert: true },
  )
  return { name: safe, replaced: Boolean(existing), sizeBytes: buffer.length }
}

export async function describeProductImage(name, description) {
  const safe = safeName(name)
  if (!safe) throw Object.assign(new Error('That is not an approved image name.'), { statusCode: 400 })
  const updated = await ProductImage.updateOne(
    { name: safe },
    { $set: { description: String(description || '').trim().slice(0, 400) } },
  )
  if (!updated.matchedCount) throw Object.assign(new Error('That image does not exist.'), { statusCode: 404 })
  return { name: safe, description: String(description || '').trim().slice(0, 400) }
}

// The shelf the writer chooses from. Only described images are offered: an image
// nobody has explained cannot be placed responsibly, and offering it invites a
// caption made up to match the filename.
export async function listPlaceableImages() {
  await seedFromDisk().catch(() => {})
  const rows = await ProductImage.find({ description: { $nin: ['', null] } }, 'name description sizeBytes').sort({ name: 1 }).lean().catch(() => [])
  // sizeBytes rides along because the image generator has a byte budget for how
  // much reference photography it can upload with each request.
  return rows.map((row) => ({ name: row.name, description: row.description, sizeBytes: row.sizeBytes || 0 }))
}

export async function setReferenceImage(name) {
  const safe = safeName(name)
  if (!safe) throw Object.assign(new Error('That is not an approved image name.'), { statusCode: 400 })
  const row = await ProductImage.findOne({ name: safe }).lean()
  if (!row) throw Object.assign(new Error('That image does not exist.'), { statusCode: 404 })
  await ProductImage.updateMany({ isReference: true }, { $set: { isReference: false } })
  await ProductImage.updateOne({ name: safe }, { $set: { isReference: true } })
  return { reference: safe }
}

export async function deleteProductImage(name) {
  const safe = safeName(name)
  if (!safe) throw Object.assign(new Error('That is not an approved image name.'), { statusCode: 400 })
  const row = await ProductImage.findOne({ name: safe }).lean()
  if (!row) throw Object.assign(new Error('That image does not exist.'), { statusCode: 404 })
  // Deleting the reference would leave the generator with no geometry and every
  // T500 depiction free to invent a device. Point somewhere else first.
  if (row.isReference) {
    throw Object.assign(
      new Error('That is the reference image. Make another image the reference before deleting it.'),
      { statusCode: 409 },
    )
  }
  await ProductImage.deleteOne({ name: safe })
  return { name: safe, deleted: true }
}
