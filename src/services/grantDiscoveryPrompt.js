const DEFAULT_GRANT_SCHEMA = {
  state: 'string',
  stateCode: 'string',
  searchedAt: 'ISO-8601 datetime',
  userProfileSummary: {
    organizationName: 'string | unknown',
    organizationType: 'string | unknown',
    state: 'string | unknown',
    serviceArea: 'string | unknown',
    projectNeeds: ['string'],
  },
  sourceFindings: [
    {
      sourceName: 'string',
      sourceUrl: 'string',
      status: 'searched | blocked | error | no_relevant_grants_found',
      summary: 'string',
      relevantLinksFound: [
        {
          label: 'string',
          url: 'string',
        },
      ],
      unknowns: ['string'],
    },
  ],
  eligibleGrants: [],
  maybeEligibleGrants: [],
  notEligibleGrants: [],
  missingUserInfo: ['string'],
}

const GRANT_OBJECT_SCHEMA = {
  grantOpportunityName: 'string',
  sponsor: 'string | unknown',
  state: 'string',
  stateCode: 'string',
  category: 'federal | state | local | private | unknown',
  focusArea: 'police | fire | ems | public_safety | emergency_management | general | other',
  amount: 'string | unknown',
  grantDeadline: 'ISO-8601 date | null',
  status: 'open | closed | recurring | unknown',
  eligibility: [
    {
      requirement: 'string',
      sourceUrl: 'string',
    },
  ],
  eligibilityFit: {
    fit: 'eligible | maybe | not_eligible',
    reasons: ['string'],
    missingInformation: ['string'],
    risks: ['string'],
  },
  stepsToRespond: [
    {
      step: 'string',
      sourceUrl: 'string',
    },
  ],
  documents: [
    {
      label: 'string',
      url: 'string',
      documentType: 'application | guidelines | notice | faq | other',
    },
  ],
  sourceUrl: 'string',
  applicationUrl: 'string | null',
  matchRequired: 'string | unknown',
  summary: 'string',
  publicSafetyRelevance: 'string',
  confidence: 'high | medium | low',
  unknowns: ['string'],
}

const FEW_SHOT_EXAMPLES = [
  {
    input: {
      userProfile: {
        organizationName: 'Example Volunteer Fire Department',
        organizationType: 'volunteer fire department',
        state: 'Tennessee',
        projectNeeds: ['turnout gear', 'thermal imaging camera'],
      },
      sourceExcerpt:
        'The Volunteer Firefighter Equipment and Training Grant is open to Tennessee volunteer fire departments. Applications are due May 30, 2026. Eligible costs include equipment and firefighter training. Maximum award is $10,000.',
    },
    output: {
      eligibleGrants: [
        {
          ...GRANT_OBJECT_SCHEMA,
          grantOpportunityName: 'Volunteer Firefighter Equipment and Training Grant',
          sponsor: 'Tennessee Department of Commerce and Insurance',
          state: 'Tennessee',
          stateCode: 'TN',
          category: 'state',
          focusArea: 'fire',
          amount: 'Maximum award is $10,000',
          grantDeadline: '2026-05-30',
          status: 'open',
          eligibility: [
            {
              requirement: 'Applicant must be a Tennessee volunteer fire department.',
              sourceUrl: 'https://example.gov/fire-grants',
            },
          ],
          eligibilityFit: {
            fit: 'eligible',
            reasons: [
              'The user is a Tennessee volunteer fire department.',
              'The requested equipment and training needs are listed as eligible costs.',
            ],
            missingInformation: [],
            risks: [],
          },
          stepsToRespond: [
            {
              step: 'Complete the grant application before the posted deadline.',
              sourceUrl: 'https://example.gov/fire-grants',
            },
          ],
          documents: [],
          sourceUrl: 'https://example.gov/fire-grants',
          applicationUrl: null,
          matchRequired: 'unknown',
          summary: 'State fire grant for Tennessee volunteer fire departments seeking equipment and training funding.',
          publicSafetyRelevance: 'Supports fire department equipment and training needs.',
          confidence: 'high',
          unknowns: ['Application URL was not visible in the source excerpt.'],
        },
      ],
      maybeEligibleGrants: [],
      notEligibleGrants: [],
      missingUserInfo: [],
    },
  },
  {
    input: {
      userProfile: {
        organizationName: 'Example County EMS',
        organizationType: 'county EMS agency',
        state: 'Tennessee',
        projectNeeds: ['radio equipment'],
      },
      sourceExcerpt:
        'The Public Safety Communications Program supports local government emergency communications projects. Eligible applicants include local governments and authorized public safety entities. Cost share may apply. Deadline not listed.',
    },
    output: {
      eligibleGrants: [],
      maybeEligibleGrants: [
        {
          ...GRANT_OBJECT_SCHEMA,
          grantOpportunityName: 'Public Safety Communications Program',
          sponsor: 'unknown',
          state: 'Tennessee',
          stateCode: 'TN',
          category: 'state',
          focusArea: 'public_safety',
          amount: 'unknown',
          grantDeadline: null,
          status: 'unknown',
          eligibility: [
            {
              requirement: 'Eligible applicants include local governments and authorized public safety entities.',
              sourceUrl: 'https://example.gov/public-safety-communications',
            },
          ],
          eligibilityFit: {
            fit: 'maybe',
            reasons: [
              'The user is a county EMS agency and may qualify as a public safety entity.',
              'Radio equipment appears related to emergency communications.',
            ],
            missingInformation: [
              'Confirm whether the EMS agency is an authorized applicant or must apply through county government.',
              'Confirm whether the grant is currently open.',
            ],
            risks: ['Deadline and cost share details were not visible.'],
          },
          stepsToRespond: [],
          documents: [],
          sourceUrl: 'https://example.gov/public-safety-communications',
          applicationUrl: null,
          matchRequired: 'Cost share may apply.',
          summary: 'Possible fit for EMS communications equipment, but applicant authority and deadline need confirmation.',
          publicSafetyRelevance: 'Supports emergency communications projects for public safety entities.',
          confidence: 'medium',
          unknowns: ['Deadline', 'award amount', 'application URL', 'exact applicant authority'],
        },
      ],
      notEligibleGrants: [],
      missingUserInfo: ['Applicant legal entity type and applying authority'],
    },
  },
]

function stringifyForPrompt(value) {
  return JSON.stringify(value, null, 2)
}

export function buildGrantDiscoveryPrompt({ state, stateCode, grantSources, userProfile = {} }) {
  return [
    'You are Trusted Tech\'s Grant Discovery Agent.',
    '',
    'Mission:',
    'Find grant opportunities from the provided source URLs and determine which ones the user is eligible for, maybe eligible for, or not eligible for.',
    '',
    'Use a hidden step-by-step reasoning process before answering:',
    '1. Understand the user profile, organization type, state, service area, and project needs.',
    '2. Inspect each provided grant source URL and identify relevant grant pages, documents, application pages, and deadlines.',
    '3. Use both the source page and any included childPages as source evidence. Child pages are likely grant, funding, search, application, or portal links found from the source page.',
    '4. Extract only source-backed facts: grant name, sponsor, amount, deadline, eligibility, match, documents, and response steps.',
    '5. Compare each grant\'s eligibility rules against the user profile.',
    '6. Classify each grant as eligible, maybe eligible, or not eligible.',
    '7. Mark weak or missing evidence as unknown instead of guessing.',
    '',
    'Do not reveal your internal reasoning. Return only valid JSON.',
    '',
    'Strict rules:',
    '- Do not invent grant facts, deadlines, amounts, eligibility rules, documents, or application steps.',
    '- If a fact is not visible in the source, use null, an empty array, or "unknown".',
    '- Include source URLs for requirements, response steps, and documents whenever possible.',
    '- If a linked portal requires login, registration, JavaScript interaction, or search before grant listings are visible, say that plainly in sourceFindings and include the portal URL as a relevant link.',
    '- Prefer active and recurring grants. Include closed grants only if they are useful recurring programs and mark status accurately.',
    '- Only include opportunities relevant to police, fire, EMS, emergency management, public safety, local government, equipment, technology, training, preparedness, or emergency communications.',
    '- If no grants are found, return empty grant arrays and summarize what was checked in sourceFindings.',
    '',
    'Grant object schema:',
    stringifyForPrompt(GRANT_OBJECT_SCHEMA),
    '',
    'Final response schema:',
    stringifyForPrompt({
      ...DEFAULT_GRANT_SCHEMA,
      eligibleGrants: [GRANT_OBJECT_SCHEMA],
      maybeEligibleGrants: [GRANT_OBJECT_SCHEMA],
      notEligibleGrants: [GRANT_OBJECT_SCHEMA],
    }),
    '',
    'Few-shot examples:',
    stringifyForPrompt(FEW_SHOT_EXAMPLES),
    '',
    'Actual input:',
    stringifyForPrompt({
      state,
      stateCode,
      userProfile,
      grantSources,
    }),
  ].join('\n')
}
