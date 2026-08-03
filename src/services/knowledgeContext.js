import mongoose from 'mongoose'
import KnowledgeRecord from '../models/KnowledgeRecord.js'

function tokens(value) {
  return new Set(
    String(value ?? '')
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) || [],
  )
}

function relevance(record, queryTokens) {
  const recordTokens = tokens([
    record.title,
    record.content,
    ...(record.products || []),
    ...(record.tags || []),
  ].join(' '))
  let score = 0
  for (const token of queryTokens) if (recordTokens.has(token)) score += 1
  if (record.products?.includes('T500')) score += 1
  return score
}

export async function getKnowledgeRecords(query = '', limit = 36) {
  if (mongoose.connection.readyState !== 1) return []
  const records = await KnowledgeRecord.find({
    visibility: 'public',
    contentUse: { $in: ['allowed', 'use_with_citation'] },
  }).lean()
  const queryTokens = tokens(query)
  return records
    .map((record) => ({ ...record, relevance: relevance(record, queryTokens) }))
    .sort((a, b) =>
      b.relevance - a.relevance ||
      (a.verificationStatus === 'approved' ? -1 : 1) ||
      a.title.localeCompare(b.title),
    )
    .slice(0, limit)
}

export async function buildKnowledgeContext(query = '', limit = 36) {
  const records = await getKnowledgeRecords(query, limit)
  if (!records.length) return 'No approved Trusted Tech knowledge records are stored yet.'
  return records.map((record) => {
    const useRule = record.verificationStatus === 'approved'
      ? 'APPROVED'
      : 'VERIFY/CITE BEFORE ASSERTING'
    return `- [${useRule}] ${record.title}: ${record.content} (source pages: ${record.sourcePages.join(', ') || 'not recorded'})`
  }).join('\n')
}
