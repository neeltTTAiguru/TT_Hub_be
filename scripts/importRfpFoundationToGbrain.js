import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const sourcePath = process.argv[2]
if (!sourcePath) {
  throw new Error('Usage: node scripts/importRfpFoundationToGbrain.js /absolute/path/to/baseline-rfp.docx')
}

const gbrainCwd = process.env.GBRAIN_MCP_CWD
const gbrainHome = process.env.GBRAIN_HOME
const bun = process.env.GBRAIN_MCP_COMMAND || '/opt/homebrew/bin/bun'
if (!gbrainCwd || !gbrainHome) throw new Error('GBRAIN_MCP_CWD and GBRAIN_HOME must be configured.')

const source = await fs.readFile(sourcePath)
const sourceHash = crypto.createHash('sha256').update(source).digest('hex')
const sourceName = path.basename(sourcePath)
const importedAt = new Date().toISOString()
const revisionDate = '2026-07-20'
const reviewBy = '2026-10-20'

const memories = [
  {
    slug: 'tt-shared/rfp/baseline-2026-07-20',
    title: 'Trusted Technology Baseline RFP — canonical foundation', pages: '1-30', department: 'shared',
    body: `This approved internal baseline is the canonical starting point for Trusted Technology RFP responses, product language, disclosure standards, pricing rules, and roadmap claims. Live systems and newer approved documents override it. Never turn a stated gap, ALTERNATIVE, or DOES NOT COMPLY response into COMPLY. New or changed claims require verification and approval before they become canonical.`,
  },
  {
    slug: 'tt-shared/company/identity-positioning',
    title: 'Trusted Technology identity and market positioning', pages: '1-3', department: 'shared',
    body: `Trusted Technology Solutions provides body-worn camera and digital evidence management technology for public safety. The company positions its T500 system as an accessible, professional-grade solution, particularly for small and mid-sized agencies. Canonical product names are T500 body-worn camera, T500 Docking Station, Trusted Vault, Vault Retrieve, and Klick Fast. Do not expose personal contact details, tax identifiers, or private reference contacts from the source document.`,
  },
  {
    slug: 'tt-shared/products/t500-system-overview',
    title: 'T500 integrated system overview', pages: '4-7', department: 'shared',
    body: `The T500 system combines the T500 body-worn camera, docking hardware, and Trusted Vault digital evidence management. The standard operating flow is: take a charged camera, record during the shift, dock for automatic secure transfer, then classify, search, review, retain, redact, and share evidence in Trusted Vault. The product is designed around a physically controlled dock transfer path rather than wireless camera connectivity.`,
  },
  {
    slug: 'tt-shared/products/t500-camera-specifications',
    title: 'T500 camera canonical specifications', pages: '4-5, 14-15', department: 'shared',
    body: `Canonical T500 specifications include 1920 × 1080 video at 30 fps, 120° horizontal and 65° vertical field of view (150° diagonal), dual microphones, 256 GB encrypted non-removable storage, a 30-second pre-event buffer, 12+ hours of continuous recording, weight 3.4 oz (95 g), IP54 rating, and six-foot drop testing. Do not claim IP67, MIL-STD certification, 4K/60 fps, GPS, a removable battery, or a different weight.`,
  },
  {
    slug: 'tt-shared/products/t500-capture-privacy-vault-retrieve',
    title: 'T500 capture model, Privacy Mode, and Vault Retrieve', pages: '6-7, 14, 28-29', department: 'shared',
    body: `Use precise capture language. The pre-event buffer and continuous shift recording are different concepts. Capture runs continuously during the shift except during officer-initiated, audit-logged Privacy Mode. Vault Retrieve lets an authorized administrator locate continuously captured footage and create an evidence record when the record button was not pressed. Never write “capture never stops” without the Privacy Mode qualification, or describe the buffer as though it were the full continuous-recording system.`,
  },
  {
    slug: 'tt-shared/products/t500-rf-silent-docking',
    title: 'T500 RF-silent design and docking', pages: '5-7, 15, 23', department: 'shared',
    body: `The T500 intentionally has no Wi-Fi, cellular, or Bluetooth radio. Evidence transfers through a physical dock connection. The eight-port docking station is intended for facility deployment; the optional single-bay dock can support low-volume, supervisor-office, or in-vehicle use. Docks require power, Ethernet, and outbound HTTPS to Trusted Vault endpoints; they do not require inbound agency-network access.`,
  },
  {
    slug: 'tt-shared/products/trusted-vault-capabilities',
    title: 'Trusted Vault core capabilities', pages: '5-8, 15-17', department: 'shared',
    body: `Trusted Vault is the browser-based digital evidence management platform for T500. The baseline describes classification, search, role-based access, audit history, configurable retention, legal holds, secure sharing, case organization, and redaction workflows. Agents must distinguish these document claims from live operational state and verify externally facing security or compliance statements before publication.`,
  },
  {
    slug: 'tt-shared/security/trusted-vault-architecture',
    title: 'Trusted Vault security and hosting architecture', pages: '7-8, 16-18, 23-24', department: 'shared',
    body: `The baseline describes Trusted Vault as SaaS hosted in United States AWS regions, with AES-256 encryption at rest, TLS 1.2/1.3 in transit, SHA-256 integrity support, role-based access control, audit logging, OIDC SSO, and MFA for local accounts. Direct Active Directory integration is not supported; OIDC/Entra ID is the supported path. Treat certification, CJIS, HIPAA, and statutory-compliance wording as claims requiring current evidence and proposal-specific review.`,
  },
  {
    slug: 'tt-shared/products/trusted-vault-retention-sharing-redaction',
    title: 'Trusted Vault retention, sharing, and redaction', pages: '7-8, 16-17, 21-22', department: 'shared',
    body: `Trusted Vault supports classification-driven retention, legal holds, audit trails, and permissioned external sharing with expiration and download controls. Veritone-assisted redaction creates a separate redacted version while preserving the source recording. Retention schedules and disclosure statements must be adapted to the governing agency policy and law; agents must not present the baseline as legal advice.`,
  },
  {
    slug: 'tt-shared/rfp/support-warranty-sla',
    title: 'Support, warranty, RMA, and availability language', pages: '8-9, 18-19, 22, 28-29', department: 'sales',
    body: `Canonical language uses expected—not guaranteed—response times. Standard live phone support is Monday–Friday, 9:00 AM–5:00 PM Central, with one-hour expected response; voicemail and email intake are available around the clock with expected response within 24 hours. RMA processing is within 24 hours, with replacement shipped within 72 hours after receipt of the faulty unit. The standard availability commitment is 99.9% monthly availability for unscheduled outages with monitoring and reporting; do not promise service credits or remedies unless separately approved.`,
  },
  {
    slug: 'tt-shared/rfp/implementation-training',
    title: 'Implementation and training baseline', pages: '9-10, 18-19', department: 'sales',
    body: `The baseline implementation model targets full operation within 30 days, with hardware shipment within two weeks, subject to engagement-specific conditions. Standard remote training is included and covers administrators, supervisors, trainers, and end users. Never shorten the deployment claim to “deployed within two weeks” when the full schedule says otherwise.`,
  },
  {
    slug: 'tt-shared/rfp/deployment-models',
    title: 'Individual assignment and shared-pool deployment models', pages: '22', department: 'sales',
    body: `Individual assignment gives each officer a permanent camera mapping and is generally the simplest operational model. Shared pool uses shift-start assignment and shift-end unassignment, reducing hardware count but adding operational steps. Mobile assignment and automatic unassign-on-dock are roadmap capabilities, not present-day launch capabilities in this revision.`,
  },
  {
    slug: 'tt-shared/rfp/disclosure-standards',
    title: 'RFP disclosure and compliance standards', pages: '12-20, 27', department: 'sales',
    body: `RFP responses must be transparent. COMPLY is used only for complete present-day compliance. ALTERNATIVE means the intent is met through a different, honestly explained mechanism. DOES NOT COMPLY states the gap plainly. Claims must be verifiable at submission time; never invent documents, experience, integrations, certifications, SLAs, or roadmap dates. Preserve qualifications and offer a roadmap only when it is real and approved.`,
  },
  {
    slug: 'tt-shared/rfp/gaps-and-objection-language',
    title: 'Canonical product gaps and objection handling', pages: '27-28', department: 'sales',
    body: `Known gap handling in this revision includes: GPS—DOES NOT COMPLY, companion-app roadmap Q4 2026; on-device field review/tagging—DOES NOT COMPLY, same roadmap app; external media upload to Vault—DOES NOT COMPLY with no promised date; direct Active Directory—not supported, use OIDC SSO; dedicated sandbox with data migration—not offered, though a second tenant may be available. IP67/MIL-STD, 4K/60 fps, selectable bitrate, and other partial matches must use the documented ALTERNATIVE framing, never bare COMPLY.`,
  },
  {
    slug: 'tt-shared/rfp/roadmap-register-2026-07-20',
    title: 'Approved roadmap register as of 2026-07-20', pages: '27-28', department: 'sales',
    body: `The approved roadmap in this revision lists Q4 2026 for a companion mobile app adding GPS coordinates to video metadata, in-field review/tagging, mobile camera assignment, and unassign-on-dock. Trusted Vault REST API is on the roadmap with no committed date. These are dated statements: verify with engineering before every external use and never attach a new date without approval.`,
  },
  {
    slug: 'tt-shared/rfp/prohibited-superseded-phrasing',
    title: 'Prohibited and superseded RFP phrasing', pages: '28-29', department: 'sales',
    body: `Do not use: guaranteed support response; service-credit remedies as standard; unqualified “capture never stops”; volume discounts; unqualified no-unilateral-access wording; wrong camera weights; NHS or London Ambulance experience claims; “tamper-proof” as a Trusted Technology claim; former personnel as current staff; or any contact, rate, deployment, warranty, or RMA wording that conflicts with the current baseline. Use tamper-resistant or tamper-evident where supported.`,
  },
  {
    slug: 'tt-confidential/rfp/pricing-rate-card-2026-07-20',
    title: 'Confidential RFP pricing rate card as of 2026-07-20', pages: '25-26, 29', department: 'sales', sensitivity: 'confidential',
    body: `Internal pricing as of this revision: five-year upfront $50 per camera/month; five-year annual $65; three-year upfront $55; three-year annual $65; one-year $75. Base redaction is $300/year for three hours; additional redaction is $100/hour. Single-bay dock is $295 one-time and magnetic mount upgrade is $30 one-time. These rates are time-sensitive, confidential, and require current verification before quoting. Do not expose internal pricing rules or one-off concessions to users lacking confidential-memory permission.`,
  },
  {
    slug: 'tt-confidential/rfp/concessions-and-internal-controls',
    title: 'Confidential concessions and proposal controls', pages: '24, 26, 29-30', department: 'sales', sensitivity: 'confidential',
    body: `One-off concessions must not become standard terms. Any deviation from canonical pricing or language requires a logged approval. Proposal-specific conflicts, insurance, margins, arrears invoicing, prior concessions, and personnel assignments must be re-confirmed for the engagement. This memory intentionally excludes names, direct contact details, and customer-specific concession values.`,
  },
  {
    slug: 'tt-shared/rfp/version-control-process',
    title: 'RFP baseline version-control process', pages: '30', department: 'shared',
    body: `Every proposal records the baseline version used. A new requirement follows draft → approval → response → incorporation into the next baseline with a change-log entry. Open VERIFY items are updated only after resolution. Each baseline revision triggers a conformance check of controlled derivatives for specs, pricing, warranty and SLA terms, personnel, recognition language, and images.`,
  },
]

function frontmatter(memory) {
  const sensitivity = memory.sensitivity || 'internal'
  return [
    '---',
    `title: ${JSON.stringify(memory.title)}`,
    'lifecycle: approved',
    `sensitivity: ${sensitivity}`,
    `department: ${memory.department}`,
    `source_uri: ${JSON.stringify(`file://${sourceName}#pages=${memory.pages}`)}`,
    `source_document: ${JSON.stringify(sourceName)}`,
    `source_pages: ${JSON.stringify(memory.pages)}`,
    `source_sha256: ${sourceHash}`,
    `source_revision: ${revisionDate}`,
    `last_verified_at: ${revisionDate}T00:00:00.000Z`,
    `observed_at: ${importedAt}`,
    `review_by: ${reviewBy}`,
    'approved_by: Neel Palle (user-directed foundation import)',
    'contains_secrets: false',
    'pii_redacted: true',
    '---',
    '',
    `# ${memory.title}`,
    '',
    memory.body,
    '',
    `Source: ${sourceName}, pages ${memory.pages}. Source revision ${revisionDate}.`,
  ].join('\n')
}

const forbidden = [
  /\b\d{2}-\d{7}\b/, // EIN
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  /(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/i,
]

for (const memory of memories) {
  const content = frontmatter(memory)
  const unsafe = forbidden.find((pattern) => pattern.test(content))
  if (unsafe) throw new Error(`PII/secret safety check failed for ${memory.slug}: ${unsafe}`)

  const result = spawnSync(bun, ['run', 'src/cli.ts', 'put', memory.slug, '--content', content], {
    cwd: gbrainCwd,
    env: { ...process.env, GBRAIN_HOME: gbrainHome, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`GBrain import failed for ${memory.slug}: ${result.stderr || result.stdout}`)
  }
}

console.log(JSON.stringify({
  source: sourceName,
  sourceSha256: sourceHash,
  revisionDate,
  importedAt,
  memoriesWritten: memories.length,
  internalMemories: memories.filter((memory) => !memory.sensitivity).length,
  confidentialMemories: memories.filter((memory) => memory.sensitivity === 'confidential').length,
  piiRedacted: true,
}))
