// Canonical list of Public Safety (body-worn / in-car video) competitors the
// Competitor Analyst agent tracks. Each entry becomes a "section" inside the
// Competitor Analyst's brain: memory saved for a competitor is scoped to this
// agent and tagged with the competitor slug below.
//
// IMPORTANT: keep this in sync with feCRM/src/data/publicSafetyCompetitors.ts.
// The backend uses this copy to validate saves; the frontend copy renders the
// section grid. The list was user-verified (WCCTV and Panasonic Connect were
// removed as out-of-scope/duplicate; Axis W-series and Transcend DrivePro Body
// added as verified public-safety BWC vendors).

export const PUBLIC_SAFETY_COMPETITORS = [
  { slug: 'axon-enterprise', name: 'Axon Enterprise', website: 'https://www.axon.com' },
  { slug: 'motorola-solutions', name: 'Motorola Solutions', website: 'https://www.motorolasolutions.com' },
  { slug: 'getac-video-solutions', name: 'Getac Video Solutions', website: 'https://www.getacvideo.com' },
  { slug: 'utility-associates', name: 'Utility Associates', website: 'https://www.utility.com' },
  { slug: 'i-pro', name: 'i-PRO (Arbitrator BWC line)', website: 'https://i-pro.com' },
  { slug: 'digital-ally', name: 'Digital Ally', website: 'https://www.digitalallyinc.com' },
  { slug: 'safe-fleet-coban', name: 'Safe Fleet (COBAN)', website: 'https://www.safefleet.net' },
  { slug: 'reveal-media', name: 'Reveal Media', website: 'https://www.revealmedia.com' },
  { slug: 'pro-vision', name: 'PRO-VISION', website: 'https://www.provisionusa.com' },
  { slug: 'wolfcom', name: 'Wolfcom', website: 'https://wolfcomusa.com' },
  { slug: 'zepcam', name: 'Zepcam', website: 'https://www.zepcam.com' },
  { slug: 'hytera', name: 'Hytera', website: 'https://www.hytera.com' },
  { slug: 'safety-vision', name: 'Safety Vision', website: 'https://www.safetyvision.com' },
  { slug: 'kustom-signals', name: 'Kustom Signals', website: 'https://www.kustomsignals.com' },
  { slug: 'wrap-technologies', name: 'Wrap Technologies (Intrensic BWC)', website: 'https://www.wrap.com' },
  { slug: 'axis-communications', name: 'Axis Communications', website: 'https://www.axis.com' },
  { slug: 'transcend', name: 'Transcend (DrivePro Body)', website: 'https://www.transcend-info.com' },
  { slug: 'pinnacle-response', name: 'Pinnacle Response', website: 'https://www.pinnacleresponse.com' },
  { slug: 'lenslock', name: 'LensLock', website: 'https://www.lenslock.com' },
  { slug: 'patrol-eyes', name: 'Patrol Eyes', website: 'https://www.patroleyes.com' },
]

const bySlug = new Map(PUBLIC_SAFETY_COMPETITORS.map((entry) => [entry.slug, entry]))

export function getCompetitorBySlug(slug) {
  return bySlug.get(String(slug || '').trim()) || null
}

export function isCompetitorSlug(slug) {
  return bySlug.has(String(slug || '').trim())
}
