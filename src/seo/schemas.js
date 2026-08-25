const defaults = {
  company_name: 'Trusted Tech',
  company_description: '',
  target_audience: [],
  article_goal: 'Educate readers',
  desired_word_count: 1800,
  tone: 'authoritative, useful, clear, and written by the company that builds the product — declarative, never hedged',
  call_to_action: '',
}

const text = (value, max = 4000) => String(value ?? '').replace(/\0/g, '').trim().slice(0, max)
const list = (value, maxItems = 50) =>
  Array.isArray(value) ? value.map((item) => text(item, 500)).filter(Boolean).slice(0, maxItems) : []

export function parseSeoInput(value = {}) {
  const primary_keyword = text(value.primary_keyword, 200)
  if (!primary_keyword) throw Object.assign(new Error('primary_keyword is required.'), { statusCode: 400 })
  const desired = Number(value.desired_word_count ?? defaults.desired_word_count)
  return {
    ...defaults,
    primary_keyword,
    company_name: text(value.company_name ?? defaults.company_name, 200),
    company_description: text(value.company_description, 4000),
    target_audience: list(value.target_audience, 20),
    article_goal: text(value.article_goal ?? defaults.article_goal, 1000),
    desired_word_count: Number.isFinite(desired) ? Math.min(5000, Math.max(500, Math.round(desired))) : 1800,
    tone: text(value.tone ?? defaults.tone, 500),
    call_to_action: text(value.call_to_action, 1000),
    manual_keyword_research: value.manual_keyword_research && typeof value.manual_keyword_research === 'object'
      ? value.manual_keyword_research : null,
    manual_surfer_recommendations:
      value.manual_surfer_recommendations && typeof value.manual_surfer_recommendations === 'object'
        ? value.manual_surfer_recommendations : null,
  }
}

function requireShape(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  for (const field of fields) {
    if (!(field in value)) throw new Error(`${label} is missing ${field}.`)
  }
  return value
}

export function validateSeoBrief(value) {
  const result = requireShape(value, [
    'primary_keyword', 'secondary_keywords', 'search_intent', 'target_audience',
    'reader_questions', 'recommended_sections', 'entities_and_concepts',
    'competitor_topics', 'differentiation_opportunities', 'claims_requiring_sources',
    'recommended_word_count', 'call_to_action',
  ], 'SEO brief')
  for (const key of ['secondary_keywords', 'target_audience', 'reader_questions', 'recommended_sections',
    'entities_and_concepts', 'competitor_topics', 'differentiation_opportunities', 'claims_requiring_sources']) {
    if (!Array.isArray(result[key])) throw new Error(`SEO brief ${key} must be an array.`)
  }
  return result
}

export function validateOutline(value) {
  const result = requireShape(value, [
    'title', 'h1', 'introduction_objective', 'sections', 'suggested_tables',
    'faq_questions', 'internal_link_placeholders', 'claims_requiring_verification',
    'conclusion', 'call_to_action',
  ], 'Outline')
  if (!Array.isArray(result.sections) || !result.sections.length) throw new Error('Outline sections must be a non-empty array.')
  for (const section of result.sections) {
    requireShape(section, ['h2', 'h3', 'key_points'], 'Outline section')
    if (!Array.isArray(section.h3) || !Array.isArray(section.key_points)) throw new Error('Outline section arrays are malformed.')
  }
  return result
}

export function slugify(value) {
  return text(value, 200).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'article'
}
