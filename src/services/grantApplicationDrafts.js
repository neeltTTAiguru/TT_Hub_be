import GrantApplicationDraft from '../models/GrantApplicationDraft.js'
import GrantOpportunity from '../models/GrantOpportunity.js'
import User from '../models/User.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/responses'
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini'

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function getTextFromResponse(payload) {
  if (!Array.isArray(payload?.output)) {
    return ''
  }

  return payload.output
    .flatMap((item) => {
      if (item?.type !== 'message' || !Array.isArray(item.content)) {
        return []
      }

      return item.content
        .filter((content) => content?.type === 'output_text' && typeof content.text === 'string')
        .map((content) => content.text)
    })
    .join('\n')
    .trim()
}

function parseJsonObject(raw) {
  const text = compactWhitespace(raw)

  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      throw new Error('Grant response generation returned non-JSON output.')
    }

    return JSON.parse(match[0])
  }
}

function safeJsonParse(value) {
  if (!value) {
    return null
  }

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function buildDraftPrompt({ user, opportunity, applicationQuestions = null }) {
  const sourceDetails = safeJsonParse(opportunity.sourceText)
  const visibleQuestions = Array.isArray(applicationQuestions?.questions) ? applicationQuestions.questions : []
  const visibleQuestionText = Array.isArray(applicationQuestions?.visibleQuestionText)
    ? applicationQuestions.visibleQuestionText
    : []
  const hasApplicationQuestions = visibleQuestions.length > 0 || visibleQuestionText.length > 0

  return [
    'You are OpenClaw\'s Grant Application Agent for Trusted Tech.',
    '',
    'Mission:',
    hasApplicationQuestions
      ? 'Generate question-specific draft answers for the visible grant application questions, plus a reusable response package.'
      : 'Generate a practical, editable first-pass grant response package for the selected organization and grant opportunity.',
    '',
    'Use hidden step-by-step reasoning before answering. Do not reveal internal reasoning. Return only valid JSON.',
    '',
    'Rules:',
    '- Do not invent agency facts, grant facts, deadlines, award amounts, eligibility rules, compliance claims, certifications, or outcomes.',
    '- Use placeholders in square brackets when facts are missing.',
    '- Keep the language practical, credible, and grant-reviewer friendly.',
    '- Do not submit anything, certify anything, or claim this is final legal/compliance advice.',
    '- The user will review this draft before any portal field is filled.',
    '- If application questions are provided, answer each concrete question directly in questionResponses.',
    '- For login, password, account, signature, certification, upload, CAPTCHA, MFA, or payment fields, do not fabricate values. Mark them as needsUserReview with missingInfo.',
    '',
    'Return this exact JSON shape:',
    JSON.stringify({
      draftTitle: 'string',
      status: 'draft | needs_review | ready',
      sections: {
        executiveSummary: 'string',
        needStatement: 'string',
        projectDescription: 'string',
        goalsAndOutcomes: 'string',
        implementationPlan: 'string',
        budgetNarrative: 'string',
        sustainabilityPlan: 'string',
        agencyBenefitStatement: 'string',
      },
      questionResponses: [
        {
          question: 'string',
          answer: 'string',
          fieldName: 'string',
          fieldType: 'string',
          confidence: 'high | medium | low',
          needsUserReview: true,
          missingInfo: ['string'],
        },
      ],
      missingInformation: ['string'],
      complianceChecklist: ['string'],
      recommendedNextSteps: ['string'],
      sourceReferences: [
        {
          label: 'string',
          url: 'string',
        },
      ],
      portalInstructions: 'string',
    }, null, 2),
    '',
    'Organization profile:',
    JSON.stringify({
      name: user.name,
      title: user.title,
      userType: user.userType,
      agencyName: user.agencyName,
      agencyType: user.agencyType,
      city: user.city,
      state: user.state,
      grantProjectFocus: user.grantProjectFocus,
      targetGrantTypes: user.targetGrantTypes,
      promptVariables: user.promptVariables,
    }, null, 2),
    '',
    'Grant opportunity:',
    JSON.stringify({
      title: opportunity.title,
      sourceAgency: opportunity.sourceAgency,
      sourceUrl: opportunity.sourceUrl,
      applicationUrl: opportunity.applicationUrl,
      grantProgram: opportunity.grantProgram,
      eligibility: opportunity.eligibility,
      deadline: opportunity.deadline,
      awardRange: opportunity.awardRange,
      matchRequired: opportunity.matchRequired,
      focusAreas: opportunity.focusAreas,
      fitTags: opportunity.fitTags,
      fitScore: opportunity.fitScore,
      summary: opportunity.summary,
      sourceDetails,
    }, null, 2),
    '',
    'Visible application questions and fields:',
    JSON.stringify(applicationQuestions || {
      note: 'No live application questions were provided. Generate a general response package only.',
    }, null, 2),
  ].join('\n')
}

export async function generateGrantApplicationDraft({ opportunityId, userId, applicationQuestions = null }) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is not configured on the backend.')
    error.statusCode = 503
    throw error
  }

  const [opportunity, user] = await Promise.all([
    GrantOpportunity.findOne({ opportunityId }),
    User.findById(userId),
  ])

  if (!opportunity) {
    const error = new Error('Grant opportunity was not found.')
    error.statusCode = 404
    throw error
  }

  if (!user) {
    const error = new Error('Application user was not found.')
    error.statusCode = 404
    throw error
  }

  const prompt = buildDraftPrompt({ user, opportunity, applicationQuestions })
  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: prompt,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    const error = new Error(body || `OpenAI request failed with ${response.status}`)
    error.statusCode = response.status
    throw error
  }

  const payload = await response.json()
  const rawModelOutput = getTextFromResponse(payload)
  const draftPayload = parseJsonObject(rawModelOutput)

  const draft = await GrantApplicationDraft.create({
    userId: user._id,
    grantOpportunityId: opportunity._id,
    status: ['draft', 'needs_review', 'ready'].includes(draftPayload.status) ? draftPayload.status : 'draft',
    draftTitle: compactWhitespace(draftPayload.draftTitle || `${opportunity.title} Response Draft`),
    sections: draftPayload.sections || {},
    questionResponses: Array.isArray(draftPayload.questionResponses) ? draftPayload.questionResponses : [],
    missingInformation: Array.isArray(draftPayload.missingInformation) ? draftPayload.missingInformation : [],
    complianceChecklist: Array.isArray(draftPayload.complianceChecklist) ? draftPayload.complianceChecklist : [],
    recommendedNextSteps: Array.isArray(draftPayload.recommendedNextSteps) ? draftPayload.recommendedNextSteps : [],
    sourceReferences: Array.isArray(draftPayload.sourceReferences) ? draftPayload.sourceReferences : [],
    portalInstructions: compactWhitespace(draftPayload.portalInstructions || ''),
    rawModelOutput,
  })

  return {
    draft,
    opportunity,
    user,
    meta: {
      model: payload.model || DEFAULT_MODEL,
      responseId: payload.id || '',
    },
  }
}
