import test from 'node:test'
import assert from 'node:assert/strict'
import { SHOWS_THE_DOCK, articleSections, buildArticleImagePlan, insertGeneratedImages, stripStagingLanguage } from '../src/services/articleImages.js'

// Approved photographs and generated artwork share one array and one renderer,
// and the two are placed by different rules: a photograph was chosen for a named
// argument and goes exactly there, while artwork spreads across whatever is left.
// These are the guarantees that keep a real photo from being shuffled away from
// the paragraph it was picked for — or dropped from the article altogether.

const HTML = `<h2>What the dock does</h2><p>One.</p>`
  + `<h2>How footage leaves the device</h2><p>Two.</p>`
  + `<h2>What it weighs</h2><p>Three.</p>`
  + `<h2>Frequently asked questions</h2><p>Four.</p>`

const PHOTO = {
  role: 'photo-1',
  source: 'approved_photo',
  url: 'https://wp.example/t500-dock-contacts.jpg',
  altText: 'The eight-pin docking contacts on the side of the T500.',
  caption: 'The eight-pin docking contacts.',
  placementAfterHeading: 'How footage leaves the device',
}

const ARTWORK = [
  { role: 'featured', url: 'https://wp.example/hero.jpg', altText: 'Hero', placementAfterHeading: '' },
  { role: 'inline-1', url: 'https://wp.example/inline-1.jpg', altText: 'Inline one', placementAfterHeading: '' },
]

test('places an approved photograph in the section it was chosen for', () => {
  const html = insertGeneratedImages(HTML, [PHOTO])
  const afterHeading = html.indexOf('<h2>How footage leaves the device</h2>')
  const photoAt = html.indexOf(PHOTO.url)
  const nextHeading = html.indexOf('<h2>What it weighs</h2>')
  assert.ok(photoAt > afterHeading, 'the photograph sits after the heading it names')
  assert.ok(photoAt < nextHeading, 'the photograph sits before the following section')
})

test('carries the photograph caption and alt text onto the page', () => {
  const html = insertGeneratedImages(HTML, [PHOTO])
  assert.ok(html.includes('The eight-pin docking contacts.'), 'the caption is rendered')
  assert.ok(html.includes('alt="The eight-pin docking contacts on the side of the T500."'))
})

test('never drops an image when photographs and artwork are mixed', () => {
  const html = insertGeneratedImages(HTML, [PHOTO, ...ARTWORK])
  for (const image of [PHOTO, ...ARTWORK]) {
    const occurrences = html.split(image.url).length - 1
    assert.equal(occurrences, 1, `${image.role} appears exactly once`)
  }
})

test('a photograph role never collides with a generated role', () => {
  // Both sets live in one array keyed by role downstream — seeding a run, finding
  // an existing image, rebuilding a post. Photographs were once handed back as
  // inline-1, which is the plan's own role, and one silently replaced the other.
  const planRoles = buildArticleImagePlan({
    article: '## What the dock does\n\nOne.\n\n## How footage leaves the device\n\nTwo.\n',
    brief: { proposedTitle: 'T500 docking', primaryKeyword: 't500 dock' },
  }).map((item) => item.role)
  assert.ok(!planRoles.includes(PHOTO.role), `generated roles ${planRoles.join(', ')} must not include ${PHOTO.role}`)
})

test('leaves the table of contents and FAQ without a picture', () => {
  const html = insertGeneratedImages(
    `<h2>In this article</h2><p>Contents.</p>${HTML}`,
    [ARTWORK[0]],
  )
  const contents = html.indexOf('<h2>In this article</h2>')
  const firstReal = html.indexOf('<h2>What the dock does</h2>')
  const image = html.indexOf(ARTWORK[0].url)
  assert.ok(image > contents && image > firstReal, 'no image is placed under a non-content heading')
})

test('blends only a real photograph into the page, never generated artwork', () => {
  const html = insertGeneratedImages(HTML, [PHOTO, ...ARTWORK])
  // Math.max: a negative start makes slice count back from the END of the string,
  // which silently reads the wrong figure when the image lands early.
  const around = (url) => html.slice(Math.max(0, html.indexOf(url) - 200), html.indexOf(url) + 200)
  const photoTag = around(PHOTO.url)
  assert.ok(photoTag.includes('mix-blend-mode:multiply'), 'the photograph blends')
  assert.ok(photoTag.includes('trusted-tech-article-photo'), 'and is marked as a photograph')
  const artTag = around(ARTWORK[0].url)
  assert.ok(!artTag.includes('mix-blend-mode'), 'generated artwork is left alone')
})

// A caption sits under a real photograph and is read by someone who is looking
// at it. The library descriptions open with the studio setup because that is how
// the writer tells the shots apart — copied into a caption it is noise, and once
// the article blends the shot into the page it is not even true.
test('cuts the studio setup out of a caption', () => {
  assert.equal(
    stripStagingLanguage('Front view of the T500 body worn camera on a plain white background, showing the rounded-rectangle housing, recessed circular lens, microphone ports, lower circular sensor area, garment clip mount, and single control on the left edge.'),
    'Front view of the T500 body worn camera, showing the rounded-rectangle housing, recessed circular lens, microphone ports, lower circular sensor area, garment clip mount, and single control on the left edge.',
  )
})

test('cuts the camera angle too, and leaves a clean sentence', () => {
  assert.equal(
    stripStagingLanguage('The T500 body worn camera photographed head-on against a plain white background. Matte black rounded-rectangle housing with a recessed circular lens.'),
    'The T500 body worn camera. Matte black rounded-rectangle housing with a recessed circular lens.',
  )
})

test('takes a studio backdrop however it is worded', () => {
  assert.equal(stripStagingLanguage('The dock contacts, shot against a seamless studio backdrop.'), 'The dock contacts.')
  assert.equal(stripStagingLanguage('The T500 over a neutral grey background.'), 'The T500.')
})

test('leaves the subject alone when the noun is not a backdrop', () => {
  const kept = 'The single control on the left edge of the housing.'
  assert.equal(stripStagingLanguage(kept), kept)
  const alsoKept = 'Footage on the device before it reaches the dock.'
  assert.equal(stripStagingLanguage(alsoKept), alsoKept)
})

test('drops a caption that was nothing but staging', () => {
  assert.equal(stripStagingLanguage('On a plain white background.'), '')
})

// The chooser matches photographs to sections. Given headings alone it is
// matching a label against a description; given the text under each heading it
// can see what the section actually argues.
const DOCKING_ARTICLE = `# T500 field guide

Intro paragraph.

## In this article

- Docking and upload workflow

## Docking and upload workflow

The T500 Docking Station is built to make the back office simpler. The 8-port
dock charges eight cameras at once, installs in under five minutes, and needs
only power and Ethernet.

## Frequently asked questions

**Does it need a server?** No.
`

test('hands the chooser what each section argues, not just its heading', () => {
  const sections = articleSections(DOCKING_ARTICLE)
  assert.deepEqual(sections.map((section) => section.heading), ['Docking and upload workflow'])
  assert.ok(
    sections[0].excerpt.includes('8-port dock charges eight cameras at once'),
    `the body text reaches the chooser, got: ${sections[0].excerpt}`,
  )
})

test('never offers the contents or the FAQ as a placement', () => {
  const headings = articleSections(DOCKING_ARTICLE).map((section) => section.heading)
  assert.ok(!headings.includes('In this article'))
  assert.ok(!headings.includes('Frequently asked questions'))
})

test('reads an article with no body under a heading without breaking', () => {
  const sections = articleSections('## Docking\n\n## Mounting\n\nBody.\n')
  assert.deepEqual(sections.map((s) => s.heading), ['Docking', 'Mounting'])
  assert.equal(sections[0].excerpt, '')
})

// Generated artwork is barred from two kinds of section. A picture above a
// specification is read as evidence for it, so that has to be a photograph of the
// real device. Docking and charging are barred outright: there is no approved
// photograph of the dock, so a generated one is an invented product.
const SPEC_HTML = `<h2>Wearing the camera</h2><p>One.</p>`
  + `<h2>Specifications</h2><p>Two.</p>`
  + `<h2>Docking and upload workflow</h2><p>Three.</p>`
  + `<h2>Why documentation matters</h2><p>Four.</p>`

test('keeps generated artwork out of the specs and docking sections', () => {
  const art = [
    { role: 'featured', url: 'https://wp.example/hero.jpg', altText: 'Hero', placementAfterHeading: '' },
    { role: 'inline-1', url: 'https://wp.example/one.jpg', altText: 'One', placementAfterHeading: '' },
  ]
  const html = insertGeneratedImages(SPEC_HTML, art)
  const specs = html.indexOf('<h2>Specifications</h2>')
  const docking = html.indexOf('<h2>Docking and upload workflow</h2>')
  const why = html.indexOf('<h2>Why documentation matters</h2>')
  for (const image of art) {
    const at = html.indexOf(image.url)
    assert.ok(at !== -1, `${image.role} is still placed`)
    const inSpecs = at > specs && at < docking
    const inDocking = at > docking && at < why
    assert.ok(!inSpecs && !inDocking, `${image.role} is not in a photograph-only section`)
  }
})

test('a photograph may still be placed in those sections', () => {
  const photo = {
    role: 'photo-1',
    source: 'approved_photo',
    url: 'https://wp.example/dock.jpg',
    altText: 'Dock contacts',
    placementAfterHeading: 'Docking and upload workflow',
  }
  const html = insertGeneratedImages(SPEC_HTML, [photo])
  const docking = html.indexOf('<h2>Docking and upload workflow</h2>')
  const why = html.indexOf('<h2>Why documentation matters</h2>')
  const at = html.indexOf(photo.url)
  assert.ok(at > docking && at < why, 'the real photograph sits in the docking section')
})

test('refuses a generated image its anchor when the anchor names a spec section', () => {
  const art = { role: 'inline-1', url: 'https://wp.example/one.jpg', altText: 'One', placementAfterHeading: 'Specifications' }
  const html = insertGeneratedImages(SPEC_HTML, [art])
  const specs = html.indexOf('<h2>Specifications</h2>')
  const docking = html.indexOf('<h2>Docking and upload workflow</h2>')
  const at = html.indexOf(art.url)
  assert.ok(at !== -1, 'it is still shown somewhere')
  assert.ok(!(at > specs && at < docking), 'but not under Specifications')
})

test('never plans generated artwork into a docking or specs section', () => {
  const plan = buildArticleImagePlan({
    article: '## Wearing the camera\n\nA.\n\n## Specifications\n\nB.\n\n## Docking and upload workflow\n\nC.\n\n## Why documentation matters\n\nD.\n',
    brief: {
      proposedTitle: 'T500 field guide',
      imageRecommendations: [{ role: 'inline', placementAfterHeading: 'Docking and upload workflow', purpose: 'the dock' }],
    },
  })
  for (const item of plan) {
    assert.ok(
      !/specifications|docking/i.test(item.placementAfterHeading || ''),
      `${item.role} was planned into "${item.placementAfterHeading}"`,
    )
  }
})

test('tells the image model never to draw a dock', () => {
  const plan = buildArticleImagePlan({ article: '## Wearing the camera\n\nA.\n', brief: { proposedTitle: 'T500' } })
  for (const item of plan) {
    assert.match(item.prompt, /NEVER DEPICT: a docking station/)
    assert.match(item.prompt, /size of a deck of cards/)
  }
})

// Reference photography teaches the image model what the device looks like. A
// photograph of the camera sitting in the dock teaches it the dock too — while
// the prompt is telling it never to draw one.
test('keeps dock photographs out of the generation reference set', () => {
  assert.ok(SHOWS_THE_DOCK.test('The T500 seated upright in its single-bay dock, viewed head-on.'))
  assert.ok(SHOWS_THE_DOCK.test('The camera docked, with the cable running out of the back.'))
  assert.ok(SHOWS_THE_DOCK.test('Four green indicator lights on the front of the dock base.'))
})

test('still treats a photograph of the camera alone as reference material', () => {
  // The contacts are ON the camera. This one is the device by itself and must
  // stay available to the generator.
  assert.ok(!SHOWS_THE_DOCK.test('The T500 in right profile, showing the eight-pin gold docking contacts on the side of the housing.'))
  assert.ok(!SHOWS_THE_DOCK.test('Front view of the T500 showing the lens and microphone ports.'))
})
