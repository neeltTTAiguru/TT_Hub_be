import fs from 'node:fs/promises'
import path from 'node:path'
import { uploadWordPressMedia } from './wordpress.js'

import { chatWithHermes } from './hermesChat.js'
import { listPlaceableImages, mimeForImage, readProductImage, resolveReference } from './productImages.js'


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
  // Generated artwork is planned only into sections it is allowed to illustrate.
  // A specs section needs a photograph of the real device, and a docking section
  // would have the model invent a dock nobody has photographed.
  const openHeadings = articleHeadings.filter((heading) => !PHOTO_ONLY_HEADING.test(heading))
  const fallbackHeadings = openHeadings.length
    ? [openHeadings[Math.floor(openHeadings.length * 0.34)], openHeadings[Math.floor(openHeadings.length * 0.68)]]
    : ['', '']
  const shared = `Create a polished, photorealistic editorial image for Trusted Technology Solutions. Article topic: ${topic}.

THE PRODUCT. The supplied photographs are the real T500 body-worn camera, shot from more than one angle. Reproduce that exact device: the same housing, lens, microphone ports, sensor area, controls and black finish. Do not restyle it, and do not invent logos, text, screens, indicator graphics or features it does not have.

SCALE. The T500 is a compact chest-worn device, roughly the size of a deck of cards — about 2.9 x 1.9 x 1.3 inches and 3.4 oz. Whatever it sits next to, it must read at that true size: on a duty uniform it is a small rectangle high on the chest, on a desk it is smaller than a phone laid flat, in a hand it is easily palmed. Getting the scale wrong is the single most obvious way this image fails, so judge it against every object you place around it.

THE SETTING. Put the real device in a believable working scene — clipped to a uniform shirt or vest, resting on a duty desk or locker shelf, in a patrol vehicle, in a hand being clipped on. The environment is yours to build; the device is not.

NEVER DEPICT: a docking station, dock, charging cradle, charging bay, multi-bay charger, or the camera seated in, on, or connected to any of them — Trusted Technology has no approved photography of the dock, so a generated one would be a product that does not exist. Also no fake product screens, agency insignia, badges, identifiable faces, readable licence plates, or any text in the image.

STYLE. Trusted Technology's restrained palette: charcoal, warm taupe, ivory, black, and subtle muted blue light. Premium public-safety technology photography, natural lighting, ample negative space, no words, no watermark.`
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
    // openHeadings, not articleHeadings: a recommendation asking for artwork in
    // the specs or docking section is refused its anchor and spread elsewhere.
    const placementAfterHeading = openHeadings.find((heading) => heading.toLowerCase() === requestedHeading.toLowerCase())
      || fallbackHeadings[index]
      || openHeadings[index]
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

// A photograph in which the camera is sitting IN the dock.
//
// These are placed in articles like any other photograph, but they are never fed
// to the image model as reference. The generation prompt forbids drawing a dock;
// handing it a picture of one and asking it not to draw one is a contradiction it
// will lose. Reference photography has to show the device alone.
//
// Deliberately narrow: "the eight-pin gold docking contacts on the side of the
// housing" is a photograph of the CAMERA and stays reference material. Only a
// description saying the camera is in or on a dock is excluded.
export const SHOWS_THE_DOCK = /\bdocked\b|\b(?:in|on)\s+(?:its|the|a)\s+(?:[\w-]+\s+)?(?:dock|cradle)\b|\bdock base\b|\bdocking station\b|\bcharging (?:cradle|bay)\b/i

// How much photography rides along with each generation request. Every reference
// is uploaded on every one of the three images an article gets, so this is a
// latency and bandwidth budget as much as a quality one — the product shots are
// 3-4MB each.
const MAX_REFERENCES = 3
const MAX_REFERENCE_BYTES = 9 * 1024 * 1024

// The photographs the model builds the device from: the approved reference first,
// then as many other described photographs as the budget allows. More angles is
// how the generated camera gets its depth and proportions right rather than being
// extruded from a single front-on view.
async function referenceImages() {
  const override = process.env.T500_IMAGE_REFERENCE_PATH
  if (override) {
    return [{
      bytes: await fs.readFile(override),
      mimeType: mimeForImage(override),
      name: path.basename(override),
    }]
  }
  const primary = await resolveReference()
  const chosen = [primary]
  let budget = MAX_REFERENCE_BYTES - primary.bytes.length
  // Smallest first, which buys the most ANGLES for the budget. Alphabetical order
  // spent it on two near-identical front views and never reached the profile —
  // and the profile is the one that tells the model how deep the housing is.
  const shelf = (await listPlaceableImages().catch(() => []))
    .filter((item) => !SHOWS_THE_DOCK.test(item.description || ''))
    .sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0))
  for (const item of shelf) {
    if (chosen.length >= MAX_REFERENCES) break
    if (item.name === primary.name) continue
    const photo = await readProductImage(item.name).catch(() => null)
    if (!photo?.bytes?.length || photo.bytes.length > budget) continue
    budget -= photo.bytes.length
    chosen.push({ bytes: photo.bytes, mimeType: photo.mimeType, name: item.name })
  }
  return chosen
}

export async function generateFromReference(prompt, signal) {
  const apiKey = clean(process.env.OPENAI_API_KEY, 500)
  if (!apiKey) throw new Error('OpenAI image generation is not configured. Add OPENAI_API_KEY to the backend environment.')
  // Whatever the image library currently points at, so approving a new photo in
  // the UI changes what every later article is generated from. The env override
  // still names a file, for pinning a reference outside the library.
  const references = await referenceImages()
  const form = new FormData()
  form.append('model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5')
  form.append('prompt', prompt)
  form.append('size', process.env.OPENAI_IMAGE_SIZE || '1536x1024')
  form.append('quality', process.env.OPENAI_IMAGE_QUALITY || 'medium')
  form.append('output_format', 'jpeg')
  form.append('output_compression', '86')
  // image[] rather than image: the endpoint takes several references, and one
  // front-on photograph is a poor brief for a device that has to sit convincingly
  // in a scene. Given the front and a profile the model can see how deep the
  // housing actually is, which is most of what "proportionally correct" means.
  //
  // The mime type comes from the file: it was hardcoded to image/png, which
  // mislabelled every real photograph.
  for (const reference of references) {
    form.append('image[]', new Blob([reference.bytes], { type: reference.mimeType }), reference.name)
  }
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

// Each section of the article with the text that sits under it.
//
// The chooser used to be handed the headings alone, and a heading is a label,
// not an argument: "Docking and upload workflow" gives nothing to match a
// photograph against beyond the word it happens to share. With the body text it
// can see the section is about eight cameras charging at once and footage moving
// off the device, and the dock-contacts photograph becomes the obvious answer
// rather than a guess.
//
// The table of contents, summary and FAQ are left out: an image anchored to one
// of those finds no section downstream and ends up spread somewhere else, so it
// must never be offered as a placement.
export function articleSections(article) {
  const text = String(article || '')
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)]
  return headings
    .map((match, index) => {
      const start = match.index + match[0].length
      const end = index + 1 < headings.length ? headings[index + 1].index : text.length
      const body = text.slice(start, end)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/[#*_`>]/g, '')
        .replace(/\s+/g, ' ')
      return {
        heading: clean(match[1].replace(/[*_`]/g, ''), 300),
        // Enough to argue from without turning the prompt into the whole
        // article: the opening of a section is where it says what it is about.
        excerpt: clean(body, 500),
      }
    })
    .filter((section) => section.heading && !NON_CONTENT_HEADING.test(section.heading))
}

// How a photograph was staged, cut out of reader-facing text.
//
// The library descriptions all open with the studio setup — "photographed
// head-on against a plain white background" — because that is how the writer
// tells one shot from another. Copied into a caption it is noise at best: the
// reader is looking at the picture. It is also wrong, since the article renders
// that background as the page colour, so the caption describes a white backdrop
// nobody can see. The prompt forbids it; this is the guard for when it happens
// anyway.
// Anchored on "background"/"backdrop" rather than on the adjectives, so it takes
// "on a plain white background" and "against a seamless studio backdrop" alike,
// and leaves "on the front of the housing" alone — that noun is not a backdrop.
const STAGING_LEAD = '(?:,\\s*|\\s+)?\\b(?:set|shot|photographed|pictured|shown|seen|taken)?\\s*(?:on|against|over|in front of)\\s+(?:a|the)\\s+(?:\\w+\\s+){0,3}?'
const STAGING_CLAUSE = new RegExp(`${STAGING_LEAD}backgrounds?\\b|${STAGING_LEAD}backdrops?\\b`, 'gi')

const STAGING_PHRASE = /(?:,\s*|\s+)?\b(?:photographed|shot|pictured|captured)\s+(?:head-on|straight on|from the (?:front|side|left|right|top|rear|back))\b/gi

export function stripStagingLanguage(value) {
  const cleaned = String(value || '')
    .replace(STAGING_CLAUSE, '')
    .replace(STAGING_PHRASE, '')
    // The cut leaves its own punctuation behind: doubled commas, a comma right
    // before the full stop, a sentence now starting with ", and".
    .replace(/\s*,\s*(?=[,.])/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/^[\s,;]+/, '')
    .trim()
  // Removing the clause can leave a fragment with no sentence left in it. An
  // empty caption is dropped downstream, which is better than a broken one.
  return /[a-z0-9]/i.test(cleaned) ? cleaned : ''
}

// Asks the writer which approved photographs belong in this article and where.
//
// This is the difference between artwork ABOUT the product and a photograph OF
// it. A generated image is fine for an atmospheric hero; it is not fine under a
// caption that states the device weighs 3.4 oz, because the picture above that
// sentence would be invented. Anything making a factual claim has to be a real
// photo, so the writer picks from the approved shelf and the original file is
// placed untouched.
export async function chooseLibraryImages(article, title, signal) {
  const shelf = await listPlaceableImages()
  if (!shelf.length) return []
  const sections = articleSections(article)
  if (!sections.length) return []
  const headings = sections.map((section) => section.heading)

  const reply = await chatWithHermes('content-operations-assistant', [{ role: 'user', content: `
Choose which approved photographs belong in this Trusted Technology article, and where.

APPROVED PHOTOGRAPHS — use the name EXACTLY as written:
${shelf.map((i) => `- ${i.name} — ${i.description}`).join('\n')}

THE ARTICLE'S SECTIONS — placementAfterHeading must be one of these headings, copied exactly. What each section actually argues is under it:
${sections.map((section) => `- ${section.heading}\n    ${section.excerpt || '(no body text)'}`).join('\n')}

RULES:
- Match on SUBJECT: read what a section argues, then ask which photograph a reader would want to be looking at while reading it. A section explaining how footage leaves the camera wants the photograph that shows the contacts it leaves through. Do not match on heading wording alone.
- These sections can ONLY be illustrated by a real photograph, so give them one whenever any photograph shows what they describe: sections that state specifications or measurements, and sections about docking, charging or how footage comes off the device. Nothing else may illustrate them — a generated picture above a specification is read as evidence for it, and there is no approved photograph of the dock for a generated one to be checked against.
- Place a photograph wherever one genuinely shows what that section is about. Do not hold back out of caution — a section discussing a part of the device that the library photographs should have that photograph. But never force one: a section no photograph shows gets none, and returning none at all is correct if none fit.
- At most one photograph per section, and at most four in total. Prefer the sections where the picture does the most work.
- The descriptions above are how YOU tell the photographs apart. They are not captions and must never be copied into one.
- A caption is written for the reader, who is looking at the picture. Say in one short sentence — 15 words or fewer — what this photograph shows that matters to the section it sits in. "The eight-pin dock contacts footage leaves through." Not a restatement of the description.
- NEVER describe how a photograph was taken or staged: no backgrounds ("on a plain white background"), no angles ("photographed head-on", "in left profile"), no lighting, framing or studio setup. The reader can see the picture; telling them what it was shot against is noise, and the background is not white once the article renders it.
- Never state a measurement, weight, price, certification or specification that the description does not give you — the caption sits under a real photo and will be read as fact.
- altText is for someone who cannot see the picture: name the subject and the parts that matter, in one sentence. The same ban on backgrounds, angles and studio setup applies.
- Do not invent a name that is not on the list.

Return ONLY valid JSON: {"images":[{"name":"","placementAfterHeading":"","caption":"","altText":""}]}
` }], { instructions: 'Do not call any tools. Return only the JSON asked for.', memoryContext: '', timeoutMs: 90000, rateLimitRetries: 1 }).catch(() => null)
  const raw = String(reply?.message?.content || '')

  let parsed = []
  try {
    parsed = JSON.parse(String(raw).slice(String(raw).indexOf('{'), String(raw).lastIndexOf('}') + 1))?.images || []
  } catch { return [] }

  const byName = new Map(shelf.map((i) => [i.name, i]))
  const used = new Set()
  return (Array.isArray(parsed) ? parsed : [])
    .map((item) => ({
      name: String(item?.name || ''),
      placementAfterHeading: clean(item?.placementAfterHeading, 300),
      caption: stripStagingLanguage(clean(item?.caption, 400)),
      altText: stripStagingLanguage(clean(item?.altText, 300)),
    }))
    // A name off the shelf, or a heading not in the article, would place nothing
    // and leave a caption stranded. Dropped here rather than downstream.
    .filter((item) => byName.has(item.name) && headings.some((h) => h.toLowerCase() === item.placementAfterHeading.toLowerCase()))
    .filter((item) => !used.has(item.name) && used.add(item.name))
    .slice(0, 4)
}

// Uploads the photographs the writer picked, exactly as they were shot. The
// bytes go from the library to WordPress media untouched — they never pass
// through the image model, which is the whole point: a redraw of the T500 is
// not a photograph of it.
async function placeLibraryPhotos({ article, title }, { signal } = {}) {
  const chosen = await chooseLibraryImages(article, title, signal)
  if (!chosen.length) return []
  return Promise.all(chosen.map(async (pick, index) => {
    const { bytes, mimeType } = await readProductImage(pick.name)
    const media = await uploadWordPressMedia({
      bytes,
      fileName: `${slugify(title || 'trusted-tech-article')}-photo-${index + 1}${path.extname(pick.name) || '.jpg'}`,
      contentType: mimeType,
      altText: pick.altText || pick.caption,
    })
    return {
      // Its own role namespace. Photographs used to be handed back as inline-1
      // and inline-2, which are the plan's own roles: everything downstream keys
      // images by role, so a generated inline-1 and a photographed inline-1 were
      // the same slot and one silently replaced the other.
      role: `photo-${index + 1}`,
      mediaId: Number(media.id),
      url: media.source_url || media.guid?.rendered || '',
      altText: pick.altText || pick.caption,
      caption: pick.caption,
      placementAfterHeading: pick.placementAfterHeading,
      // Marked so nothing downstream mistakes a real photograph for artwork.
      source: 'approved_photo',
    }
  })).catch(() => [])
}

// Sections a photograph already holds, so generated artwork is never planned
// into one of them.
function headingsTakenBy(photos) {
  return new Set(photos
    .map((photo) => String(photo?.placementAfterHeading || '').toLowerCase())
    .filter(Boolean))
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
  // Real photographs first. Whatever the library covers is placed as-is; only
  // the slots it does not cover fall through to generation.
  const placed = await placeLibraryPhotos({ article: draft.article, title }, { signal })
  const takenHeadings = headingsTakenBy(placed)
  const plan = buildArticleImagePlan(draft).filter((item) => !takenHeadings.has(String(item.placementAfterHeading || '').toLowerCase()))
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
      source: 'generated',
    }
  }))
  // Photographs first so they read as the article's evidence, with generated
  // artwork filling only what the library could not cover.
  return [...placed, ...generated]
}

export async function generateAndUploadArticleImages(run, { signal } = {}) {
  const existingImages = Array.isArray(run.generatedImages) ? [...run.generatedImages] : []
  // Photographs the Write page already placed and seeded onto this run. They are
  // carried through untouched: the plan below only describes generated artwork,
  // so anything rebuilt from the plan alone would drop them on the floor.
  const photos = existingImages.filter((image) => (
    image?.source === 'approved_photo' || String(image?.role || '').startsWith('photo-')
  ))
  // A run that never went near the browser — the autonomous pipeline — picks its
  // own photographs, so it illustrates from the library too instead of
  // generating every picture in the article.
  const placed = existingImages.length
    ? photos
    : await placeLibraryPhotos({ article: run.article, title: run.brief?.proposedTitle || '' }, { signal })
  const takenHeadings = headingsTakenBy(placed)
  const plan = buildArticleImagePlan(run)
    .filter((item) => !takenHeadings.has(String(item.placementAfterHeading || '').toLowerCase()))
  const findExisting = (role) => existingImages.find((image) => (
    image.role === role || (role === 'inline-1' && image.role === 'inline')
  ))
  const missingPlan = plan.filter((item) => !findExisting(item.role))
  if (!missingPlan.length) {
    run.generatedImages = [...placed, ...plan.map((item) => ({ ...findExisting(item.role), ...item }))]
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
    const images = [...placed, ...plan.map((item) => {
      const existing = findExisting(item.role)
      const created = createdImages.find((image) => image.role === item.role)
      return { ...(existing || created), ...item }
    })]
    run.generatedImages = images
    run.stages.push({
      cycle: Number(run.currentCycle || 0),
      stage: 'image_generation', status: 'complete', tool: 'Approved photo library + OpenAI Images + WordPress Media API',
      result: placed.length
        ? `${placed.length} approved photograph(s) placed and ${images.length - placed.length} image(s) generated.`
        : `${images.length} topic-specific article images are generated and uploaded.`,
      explanation: placed.length
        ? 'Approved photographs were uploaded exactly as shot and placed in the sections they illustrate. Generated artwork filled only the sections no photograph covered, working from the approved T500 reference.'
        : 'The article topic drove each scene, while the approved T500 reference preserved product identity.',
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

// Sections a REAL photograph may illustrate and generated artwork may not.
//
// Two different reasons, one rule. A specifications section states facts — weight,
// dimensions, port counts — and a picture above those sentences is read as
// evidence for them, so it has to be a photograph of the actual device. Docking
// and charging are barred for a blunter reason: Trusted Technology has no approved
// photography of the dock, so anything generated there is an invented product, and
// a reader cannot tell an invented dock from a real one.
//
// Mirrored in MarkdownArticle.tsx, so the draft panel spreads artwork the same way.
const PHOTO_ONLY_HEADING = /\b(?:spec(?:ification)?s?|technical details|at a glance|dock|docks|docking|docking station|undock(?:ing)?|charg(?:e|es|er|ers|ing)|cradle|what'?s in the box)\b/i

// Mirrored by figure() in MarkdownArticle.tsx, so the draft panel shows what the
// post will look like.
//
// A product photograph is shot on white and lands on the site's ivory as a bright
// card sitting on the page rather than part of it. Multiply makes its white take
// the colour underneath — whatever the page is — while the black housing stays
// black. Carried inline rather than as a theme rule so it travels with the post.
// Generated artwork never gets it: blending a full-colour scene against ivory
// would darken and warm the whole image.
function articleFigure(image) {
  const photo = image.source === 'approved_photo'
  const className = `wp-block-image size-large trusted-tech-article-image${photo ? ' trusted-tech-article-photo' : ''}`
  const style = photo ? ' style="mix-blend-mode:multiply"' : ''
  return `<figure class="${className}"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText)}" loading="lazy"${style}/>${image.caption ? `<figcaption class="wp-element-caption">${escapeHtml(image.caption)}</figcaption>` : ''}</figure>`
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
    const at = wanted ? sections.findIndex((entry) => entry.text.toLowerCase() === wanted) : -1
    // One image per section, and a generated one may not take a section reserved
    // for photographs — an invented dock beside the docking paragraph reads as the
    // real dock. Refused here as well as in the plan, because this is the last
    // place that can tell: an anchor survives rewrites that rename the heading.
    const allowed = at >= 0
      && !anchored.some((entry) => entry.section === at)
      && (image.source === 'approved_photo' || !PHOTO_ONLY_HEADING.test(sections[at].text))
    if (allowed) anchored.push({ image, section: at })
    else floating.push(image)
  }

  const used = new Set(anchored.map((entry) => entry.section))
  // Generated artwork spreads across the sections it is allowed to illustrate.
  // Without this it lands wherever the spacing falls, which is how a generated
  // picture ends up under "Specifications" having been kept out of the plan.
  const free = sections
    .map((_, index) => index)
    .filter((index) => !used.has(index) && !PHOTO_ONLY_HEADING.test(sections[index].text))
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
