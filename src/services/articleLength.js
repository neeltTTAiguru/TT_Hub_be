// Word-count enforcement against SurferSEO's target.
//
// Surfer's target_word_count is what the ranking pages average for the keyword.
// The writer and reviser prompts have always been TOLD the number, but nothing
// ever measured the result — and the optimisation loop kept whichever revision
// scored highest on term coverage, so an over-long draft that scored a point
// better won every time. Recent runs came out 27–42% over target. This module
// is the measurement: one place that says how long the article is, how long it
// should be, and exactly what the reviser has to do about it.

const DEFAULT_TOLERANCE = 0.15
const MIN_TOLERANCE = 0.05
const MAX_TOLERANCE = 0.5

export function wordCount(text) {
  return String(text || '')
    // Headings, emphasis and list markers are layout, not words; Surfer does not
    // count "##" and neither should we.
    .replace(/^[#>\-*+\s]+/gm, '')
    .replace(/[*_`~]/g, '')
    .split(/\s+/)
    .filter(Boolean).length
}

// ±15% unless overridden. Surfer's own editor shades its word-count bar the
// same way — the target is an average, not a ceiling, so a band is honest.
export function lengthTolerance() {
  const raw = Number(process.env.CONTENT_OPS_WORD_COUNT_TOLERANCE)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TOLERANCE
  return Math.min(MAX_TOLERANCE, Math.max(MIN_TOLERANCE, raw))
}

// { words, target, min, max, tolerance, status: ok|short|long|unknown, ok, delta }
// delta is signed words from the nearest edge of the band: negative means that
// many words must be cut, positive that many must be added. Inside the band it
// is 0. `unknown` means Surfer gave no target, so nothing can be enforced.
export function checkArticleLength(article, target, { tolerance = lengthTolerance() } = {}) {
  const words = wordCount(article)
  const goal = Number(target)
  if (!Number.isFinite(goal) || goal <= 0) {
    return { words, target: null, min: null, max: null, tolerance, status: 'unknown', ok: true, delta: 0 }
  }
  const min = Math.round(goal * (1 - tolerance))
  const max = Math.round(goal * (1 + tolerance))
  const status = words < min ? 'short' : words > max ? 'long' : 'ok'
  const delta = status === 'short' ? min - words : status === 'long' ? max - words : 0
  return { words, target: goal, min, max, tolerance, status, ok: status === 'ok', delta }
}

export function describeLengthCheck(check) {
  const words = check.words.toLocaleString()
  if (check.status === 'unknown') return `${words} words — Surfer gave no word target, so length was not checked.`
  const band = `Surfer target ${check.target.toLocaleString()} (±${Math.round(check.tolerance * 100)}% → ${check.min.toLocaleString()}–${check.max.toLocaleString()})`
  if (check.ok) return `${words} words against ${band} — within range.`
  const gap = Math.abs(check.delta).toLocaleString()
  return check.status === 'long'
    ? `${words} words against ${band} — ${gap} words over the range.`
    : `${words} words against ${band} — ${gap} words under the range.`
}

// The prompt block that makes the length a hard instruction rather than a hint.
// A cut says how much to remove and where it comes from; an addition names the
// only honest way to add words — answering questions searchers actually ask —
// so the reviser never pads what is already there.
export function lengthDirective(check, questions = []) {
  if (check.status === 'unknown') return ''
  const band = `${check.min}–${check.max} words (SurferSEO target ${check.target})`
  if (check.ok) {
    return `LENGTH — the article is ${check.words} words, inside the required ${band}. Keep it there: every change must leave the total between ${check.min} and ${check.max} words. Do not add sections.`
  }
  if (check.status === 'long') {
    // Ask for the middle of the band, not its edge, so a slightly generous cut
    // does not land it back outside on the other side.
    const aim = Math.round((check.min + check.max) / 2)
    return `LENGTH — HARD REQUIREMENT, CHECKED BY THE PIPELINE: the article is ${check.words} words; it must be ${band}. Cut at least ${Math.abs(check.delta)} words and aim for about ${aim}. Remove restatement, merge overlapping sections, shorten the intro and summary, drop the weakest FAQ entries, and delete any section that repeats another. Keep every H2 that carries a recommended term. A revision still over ${check.max} words is rejected.`
  }
  const aim = Math.round((check.min + check.max) / 2)
  const asked = Array.isArray(questions) && questions.length
    ? ` Add length ONLY by answering searcher questions the article does not yet cover — pick from: ${questions.slice(0, 8).map((q) => `"${q}"`).join('; ')}.`
    : ' Add length ONLY by covering a genuine gap — a step, a decision, or a question a reader in the target role would ask — never by restating or elaborating what is already said.'
  return `LENGTH — HARD REQUIREMENT, CHECKED BY THE PIPELINE: the article is ${check.words} words; it must be ${band}. Add at least ${check.delta} words and aim for about ${aim}.${asked} Never invent facts, statistics, or product claims to fill space. A revision still under ${check.min} words is rejected.`
}
