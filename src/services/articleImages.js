import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { uploadWordPressMedia } from './wordpress.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REFERENCE = path.resolve(moduleDir, '../../assets/article-images/t500-camera-reference.png')

const REFERENCE_MIME_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

// A real photograph is usually a JPEG, and the type was hardcoded to image/png.
function referenceMimeType(filePath) {
  return REFERENCE_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'image/png'
}



function clean(value, max = 2000) {
  return String(value ?? '').replace(/\0/g, '').trim().slice(0, max)
}

function slugify(value) {
  return clean(value, 160).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'article'
}

function topicContext(run) {
  return clean([
    run.brief?.proposedTitle,
    run.brief?.primaryKeyword,
    run.selectedOpportunity?.title,
    run.userInstructions,
  ].filter(Boolean).join('. '), 1800)
}

export function buildArticleImagePlan(run) {
  const topic = topicContext(run)
  const recommendations = Array.isArray(run.brief?.imageRecommendations)
    ? run.brief.imageRecommendations
    : []
  const articleHeadings = [...String(run.article || '').matchAll(/^##\s+(.+)$/gm)]
    .map((match) => clean(match[1].replace(/[*_`]/g, ''), 300))
    .filter((heading) => heading && !/^(?:in this article|summary|frequently asked questions|next steps?)\b/i.test(heading))
  const inlineRecommendations = recommendations.filter((item) => item?.role !== 'featured')
  const fallbackHeadings = articleHeadings.length
    ? [articleHeadings[Math.floor(articleHeadings.length * 0.34)], articleHeadings[Math.floor(articleHeadings.length * 0.68)]]
    : ['', '']
  const shared = `Create a polished, photorealistic editorial image for Trusted Technology Solutions. Article topic: ${topic}. Preserve the supplied T500 body-worn camera's exact recognizable shape, lens, controls, proportions, and black finish. The camera must remain the real product; do not invent logos, text, UI, or product features. Use Trusted Technology's restrained palette: charcoal, warm taupe, ivory, black, and subtle muted blue light. Premium public-safety technology photography, believable environment, natural lighting, ample negative space, no words, no watermark.`
  const repo = /\b(repo|repossession|recovery agent|tow(?:ing)?)\b/i.test(topic)

  const featured =
    {
      role: 'featured',
      placementAfterHeading: '',
      altText: clean(recommendations.find((item) => item?.role === 'featured')?.altText || `T500 body-worn camera for ${run.brief?.proposedTitle || topic}`, 300),
      caption: '',
      prompt: `${shared} Landscape hero composition. ${repo ? 'Show a professional repossession or vehicle-recovery setting at dusk with a tow vehicle in the background; no confrontation, weapons, police insignia, readable plates, or visible private data.' : 'Build the scene around the article subject in a credible professional field setting.'}`,
    }
  const inline = [0, 1].map((index) => {
    const recommendation = inlineRecommendations[index] || {}
    const requestedHeading = clean(recommendation.placementAfterHeading, 300)
    const placementAfterHeading = articleHeadings.find((heading) => heading.toLowerCase() === requestedHeading.toLowerCase())
      || fallbackHeadings[index]
      || articleHeadings[index]
      || ''
    return {
      role: `inline-${index + 1}`,
      placementAfterHeading,
      altText: clean(recommendation.altText || `T500 camera supporting ${placementAfterHeading || run.brief?.primaryKeyword || topic}`, 300),
      caption: clean(recommendation.caption || '', 300),
      prompt: `${shared} Landscape supporting image for the article section titled “${placementAfterHeading}”. Illustrate this specific concept: ${clean(recommendation.purpose || recommendation.prompt || placementAfterHeading || topic, 900)}. Use a distinct composition from the hero and other supporting image. Make the scene directly useful to a reader at this exact point in the article.`,
    }
  })
  return [featured, ...inline]
}

async function generateFromReference(prompt, signal) {
  const apiKey = clean(process.env.OPENAI_API_KEY, 500)
  if (!apiKey) throw new Error('OpenAI image generation is not configured. Add OPENAI_API_KEY to the backend environment.')
  // Whatever the image library currently points at, so approving a new photo in
  // the UI changes what every later article is generated from. The env override
  // still names a file, for pinning a reference outside the library.
  const referencePath = process.env.T500_IMAGE_REFERENCE_PATH || DEFAULT_REFERENCE
  const bytes = await fs.readFile(referencePath)
  const form = new FormData()
  form.append('model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5')
  form.append('prompt', prompt)
  form.append('size', process.env.OPENAI_IMAGE_SIZE || '1536x1024')
  form.append('quality', process.env.OPENAI_IMAGE_QUALITY || 'medium')
  form.append('output_format', 'jpeg')
  form.append('output_compression', '86')
  // The reference is whatever product photography is currently approved, and a
  // real camera produces JPEG. Hardcoding image/png mislabelled those bytes to
  // the image API, so the type is taken from the file itself.
  form.append('image', new Blob([bytes], { type: referenceMimeType(referencePath) }), path.basename(referencePath))
  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error?.message || `Image generation failed with HTTP ${response.status}.`)
  const base64 = payload?.data?.[0]?.b64_json
  if (!base64) throw new Error('Image generation returned no image data.')
  return Buffer.from(base64, 'base64')
}

// Plan, generate and upload artwork for an article with no pipeline run behind
// it — the chat surface passes the draft it is currently holding. Returns the
// same image shape the run-based path stores, so both the WordPress post and the
// draft pane place them identically.
export async function generateArticleImagesForDraft(
  { article, title = '', primaryKeyword = '', instructions = '' },
  { signal } = {},
) {
  const draft = {
    article: String(article || ''),
    brief: { proposedTitle: title, primaryKeyword, imageRecommendations: [] },
    userInstructions: instructions,
  }
  const plan = buildArticleImagePlan(draft)
  const generated = await Promise.all(plan.map(async (item, index) => {
    const bytes = await generateFromReference(item.prompt, signal)
    const media = await uploadWordPressMedia({
      bytes,
      fileName: `${slugify(title || 'trusted-tech-article')}-${item.role}-${index + 1}.jpg`,
      contentType: 'image/jpeg',
      altText: item.altText,
    })
    return {
      ...item,
      mediaId: Number(media.id),
      url: media.source_url || media.guid?.rendered || '',
      generatedAt: new Date().toISOString(),
    }
  }))
  return generated
}

export async function generateAndUploadArticleImages(run, { signal } = {}) {
  const existingImages = Array.isArray(run.generatedImages) ? [...run.generatedImages] : []
  const plan = buildArticleImagePlan(run)
  const findExisting = (role) => existingImages.find((image) => (
    image.role === role || (role === 'inline-1' && image.role === 'inline')
  ))
  const missingPlan = plan.filter((item) => !findExisting(item.role))
  if (!missingPlan.length) {
    run.generatedImages = plan.map((item) => ({ ...findExisting(item.role), ...item }))
    return run.generatedImages
  }
  run.currentStage = 'image_generation'
  run.status = 'running'
  await run.save()
  try {
    const title = run.brief?.proposedTitle || run.selectedOpportunity?.title || 'trusted-tech-article'
    const createdImages = await Promise.all(missingPlan.map(async (item, index) => {
      const bytes = await generateFromReference(item.prompt, signal)
      const media = await uploadWordPressMedia({
        bytes,
        fileName: `${slugify(title)}-${item.role}-${index + 1}.jpg`,
        contentType: 'image/jpeg',
        altText: item.altText,
      })
      return {
        ...item,
        mediaId: Number(media.id),
        url: media.source_url || media.guid?.rendered || '',
        generatedAt: new Date().toISOString(),
      }
    }))
    const images = plan.map((item) => {
      const existing = findExisting(item.role)
      const created = createdImages.find((image) => image.role === item.role)
      return { ...(existing || created), ...item }
    })
    run.generatedImages = images
    run.stages.push({
      cycle: Number(run.currentCycle || 0),
      stage: 'image_generation', status: 'complete', tool: 'OpenAI Images + WordPress Media API',
      result: `${images.length} topic-specific article images are generated and uploaded.`,
      explanation: 'The article topic drove each scene, while the approved T500 reference preserved product identity.',
      output: images.map((image) => image.url).join('\n'), completedAt: new Date().toISOString(),
    })
    await run.save()
    return images
  } catch (error) {
    run.status = error?.name === 'AbortError' ? 'stopped' : 'error'
    if (!run.errors.includes(error.message)) run.errors.push(error.message)
    await run.save()
    throw error
  }
}

function escapeHtml(value) {
  return clean(value, 2000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Sections that are not part of the article's argument and must never take an image:
// the table of contents, the wrap-up and the FAQ. Mirrored in MarkdownArticle.tsx on
// the frontend, which places the same images the same way in the draft pane.
const NON_CONTENT_HEADING = /^(?:in this article|on this page|contents|summary|frequently asked questions|faqs?|next steps?)\b/i

function articleFigure(image) {
  return `<figure class="wp-block-image size-large trusted-tech-article-image"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText)}" loading="lazy"/>${image.caption ? `<figcaption class="wp-element-caption">${escapeHtml(image.caption)}</figcaption>` : ''}</figure>`
}

// Which sections get a photo. Every article gets the same shape — one after the intro,
// one in the middle, one at the end — so the slots are spread evenly across the real
// sections rather than read from each image's stored anchor. Anchors were planned once
// from the headings of the day and quietly went stale every time a rewrite renamed a
// heading, which dropped the image at the very bottom of the post instead.
function imageSlots(count, sectionCount) {
  const slots = []
  if (!sectionCount) return slots
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0 : index / (count - 1)
    let slot = Math.round(ratio * (sectionCount - 1))
    while (slots.includes(slot) && slot < sectionCount - 1) slot += 1
    while (slots.includes(slot) && slot > 0) slot -= 1
    // More images than sections — the rest are appended by the caller.
    if (slots.includes(slot)) break
    slots.push(slot)
  }
  return slots
}

export function insertGeneratedImages(html, images = []) {
  // Safety net: drop any paragraph that is an internal image/production note the
  // article writer leaked into prose (the primary strip happens on the Markdown,
  // in stripProductionNotes). Matches on production-only tokens rather than exact
  // phrasing so variants like "Featured image placement, after this section:" are
  // removed too.
  let output = String(html || '')
    .replace(/<p[^>]*>(?:(?!<\/p>)[\s\S])*?(?:assets\/article-images\/|(?:featured|inline|hero|supporting)\s+image\s+(?:placement|note)|\bimage\s+(?:placement|note)\s*[:,-]|\bsource:\s*(?:approved_t500_reference|approved_media|generated_conceptual)|\brole:\s*(?:featured|inline)\b)(?:(?!<\/p>)[\s\S])*?<\/p>/gi, '')

  const usable = (Array.isArray(images) ? images : []).filter((image) => image?.url)
  if (!usable.length) return output

  // The hero leads, then the supporting images in order. The hero is also the post's
  // featured image, but the theme does not render that on the article itself, so
  // without this the top of every article has no photo at all.
  const ordered = [
    ...usable.filter((image) => image.role === 'featured'),
    ...usable.filter((image) => image.role !== 'featured'),
  ]

  const sections = [...output.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((match) => ({
      end: match.index + match[0].length,
      text: match[1].replace(/<[^>]+>/g, '').trim(),
    }))
    .filter((section) => section.text && !NON_CONTENT_HEADING.test(section.text))

  // An image that names its section goes THERE. Approved photographs are chosen
  // for a specific argument — the dock contacts belong beside the paragraph about
  // footage leaving over a wire — and spreading them evenly threw that choice away
  // and put them wherever the spacing happened to land. Generated artwork, which
  // names no section, still spreads.
  const anchored = []
  const floating = []
  for (const image of ordered) {
    const wanted = String(image.placementAfterHeading || '').trim().toLowerCase()
    const section = wanted ? sections.findIndex((entry) => entry.text.toLowerCase() === wanted) : -1
    if (section >= 0) anchored.push({ image, section })
    else floating.push(image)
  }

  const taken = new Set(anchored.map((entry) => entry.section))
  const free = sections.map((_, index) => index).filter((index) => !taken.has(index))
  const spread = imageSlots(floating.length, free.length)
  const placements = [
    ...anchored,
    ...spread.map((slot, index) => ({ image: floating[index], section: free[slot] })),
  ]

  // Anything with no section to sit in still gets shown, at the end, as before.
  for (const image of floating.slice(spread.length)) output += articleFigure(image)

  // Back to front, so an insertion never invalidates the offsets still to be used.
  for (const entry of placements.sort((a, b) => b.section - a.section)) {
    const at = sections[entry.section].end
    output = `${output.slice(0, at)}${articleFigure(entry.image)}${output.slice(at)}`
  }
  return output
}
