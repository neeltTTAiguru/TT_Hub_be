const array = (value) => Array.isArray(value) ? value : []
const nullableNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null

export function normalizeAhrefs(raw = {}, primaryKeyword = '') {
  const keyword = raw.keyword_overview ?? raw.keyword ?? raw
  const serp = raw.serp_overview ?? raw.serp ?? {}
  return {
    primary_keyword: primaryKeyword,
    search_volume: nullableNumber(keyword.search_volume ?? keyword.volume),
    keyword_difficulty: nullableNumber(keyword.keyword_difficulty ?? keyword.difficulty),
    parent_topic: keyword.parent_topic?.keyword ?? keyword.parent_topic ?? null,
    related_keywords: array(raw.related_keywords ?? raw.keywords).slice(0, 50),
    questions: array(raw.matching_questions ?? raw.questions).slice(0, 30),
    competitors: array(raw.competitors ?? serp.competitors).slice(0, 30),
    serp_results: array(raw.serp_results ?? serp.results).slice(0, 20).map((item) => ({
      position: nullableNumber(item.position),
      title: item.title ?? '',
      url: item.url ?? '',
      description: item.description ?? item.snippet ?? '',
      domain: item.domain ?? '',
    })),
    source: 'ahrefs',
  }
}

export function normalizeSurfer(raw = {}) {
  return {
    content_score: nullableNumber(raw.content_score ?? raw.contentScore ?? raw.score),
    recommended_terms: array(raw.recommended_terms ?? raw.terms).slice(0, 100),
    missing_topics: array(raw.missing_topics ?? raw.missingTopics).slice(0, 50),
    overused_terms: array(raw.overused_terms ?? raw.overusedTerms).slice(0, 50),
    recommended_word_count: nullableNumber(raw.recommended_word_count ?? raw.wordCount),
    heading_recommendations: array(raw.heading_recommendations ?? raw.headings).slice(0, 30),
    other_recommendations: array(raw.other_recommendations ?? raw.recommendations).slice(0, 50),
    source: 'surfer',
  }
}
