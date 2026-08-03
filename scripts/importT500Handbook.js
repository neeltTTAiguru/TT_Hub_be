import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import mongoose from 'mongoose'
import { PDFParse } from 'pdf-parse'
import KnowledgeDocument from '../src/models/KnowledgeDocument.js'
import KnowledgeRecord from '../src/models/KnowledgeRecord.js'
import CompanyContext from '../src/models/CompanyContext.js'
import Product from '../src/models/Product.js'

const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('Usage: node scripts/importT500Handbook.js /absolute/path/to/handbook.pdf')

const approvedAt = new Date()
const approvedBy = 'Neel Palle'

const facts = [
  ['audience', 'target-agencies', 'Target agency profile', 'The T500 system is positioned for law enforcement, public safety, and security teams, with particular emphasis on small and mid-sized agencies that are underserved by enterprise body-camera platforms.', [1], ['T500'], ['audience', 'positioning'], 'approved', 'allowed'],
  ['positioning', 'complete-system', 'Complete integrated system', 'The T500 offering combines the T500 body-worn camera, T500 docking station, and Trusted Vault digital evidence management platform.', [3, 4, 5], ['T500', 'T500 Docking Station', 'Trusted Vault'], ['system', 'overview'], 'approved', 'allowed'],
  ['specification', 'camera-video', 'T500 video specifications', 'The T500 records 1920 x 1080 Full HD video at 30 FPS, has a 120-degree field of view, supports low-light operation, and includes dual microphones.', [4], ['T500'], ['camera', 'video'], 'approved', 'allowed'],
  ['specification', 'camera-battery', 'T500 battery and charging', 'The T500 is described as supporting 12+ hours of continuous recording and recharging in under four hours.', [4], ['T500'], ['battery', 'charging'], 'approved', 'allowed'],
  ['specification', 'camera-storage', 'T500 on-device storage', 'The T500 includes 256 GB of encrypted on-device storage, described as supporting more than 50 hours of footage and a 30-second pre-event buffer.', [4], ['T500'], ['storage', 'pre-event'], 'approved', 'allowed'],
  ['specification', 'camera-durability', 'T500 durability and weight', 'The T500 is listed at 3.4 oz / 95 g, IP54 rated, six-foot drop tested, and designed for operation from -4 F to 120 F.', [3, 4], ['T500'], ['durability', 'weight'], 'approved', 'allowed'],
  ['workflow', 'dock-eight-port', 'Eight-port docking station', 'The standard docking station charges up to eight cameras simultaneously and provides automatic secure upload and firmware management using power and Ethernet.', [4, 5], ['T500 Docking Station'], ['dock', 'upload'], 'approved', 'allowed'],
  ['workflow', 'dock-single-bay', 'Single-bay dock option', 'A single-bay dock is available for supervisor offices, small posts, or in-vehicle deployments.', [4, 9], ['T500 Docking Station'], ['dock'], 'approved', 'allowed'],
  ['accessory', 'mount-options', 'Included mounting options', 'The T500 uses the Klick Fast mounting system. Included choices are described as a MOLLE dock, leather belt-loop dock, or crocodile garment clip; a magnetic quick-release mount is optional.', [5], ['T500'], ['mounts', 'accessories'], 'approved', 'allowed'],
  ['security', 'vault-hosting', 'Trusted Vault hosting and access model', 'Trusted Vault is described as a browser-based, cloud-hosted evidence platform on AWS infrastructure in the United States. Agencies control access, and Trusted Technology is described as having no unilateral access to agency footage.', [5], ['Trusted Vault'], ['cloud', 'access'], 'needs_verification', 'use_with_citation'],
  ['security', 'vault-encryption', 'Trusted Vault encryption', 'The handbook states that Trusted Vault uses AES-256 encryption at rest and TLS 1.2/1.3 in transit.', [5], ['Trusted Vault'], ['encryption', 'security'], 'needs_verification', 'use_with_citation'],
  ['security', 'vault-audit', 'Trusted Vault audit and integrity controls', 'The handbook describes a tamper-resistant audit trail for uploads, views, shares, and deletions, plus SHA-256 integrity hashing for chain-of-custody support.', [5], ['Trusted Vault'], ['audit', 'chain-of-custody'], 'needs_verification', 'use_with_citation'],
  ['security', 'vault-cjis', 'CJIS alignment claim', 'The handbook describes Trusted Vault as hosted on CJIS-compliant AWS infrastructure and operated in alignment with the FBI CJIS Security Policy.', [1, 5], ['Trusted Vault'], ['CJIS', 'compliance'], 'needs_verification', 'use_with_citation'],
  ['feature', 'vault-access-controls', 'Trusted Vault access controls', 'Trusted Vault is described as supporting role-based access control, Microsoft Entra ID and Okta single sign-on, and restricted playback for sensitive video.', [5], ['Trusted Vault'], ['SSO', 'permissions'], 'needs_verification', 'use_with_citation'],
  ['feature', 'vault-retention', 'Trusted Vault retention controls', 'The handbook describes automated retention rules by classification, legal holds, and a seven-day deletion grace period.', [5], ['Trusted Vault'], ['retention', 'legal-hold'], 'needs_verification', 'use_with_citation'],
  ['feature', 'vault-search-sharing', 'Trusted Vault search and sharing', 'Trusted Vault is described as supporting search by officer, date, device, case number, or classification; case packages; and secure expiring, download-limited sharing links.', [5], ['Trusted Vault'], ['search', 'sharing'], 'needs_verification', 'use_with_citation'],
  ['feature', 'redaction', 'AI-assisted redaction', 'Trusted Vault integrates Veritone Redact for AI-assisted video and audio redaction. Redaction produces a separate copy while preserving the original recording.', [6], ['Trusted Vault'], ['redaction', 'Veritone'], 'needs_verification', 'use_with_citation'],
  ['workflow', 'four-step-workflow', 'T500 operating workflow', 'The described operating workflow is: grab a charged camera, start evidentiary recording with one press, dock at end of shift for automatic upload, then classify, tag, search, share, and manage evidence in Trusted Vault.', [6], ['T500', 'T500 Docking Station', 'Trusted Vault'], ['workflow'], 'approved', 'allowed'],
  ['differentiator', 'rf-silent', 'RF-silent design', 'The T500 is designed without Wi-Fi, cellular, or Bluetooth radios. Video transfer occurs through the physically controlled dock connection.', [7], ['T500'], ['RF-silent', 'security'], 'approved', 'allowed'],
  ['feature', 'vault-retrieve', 'Vault Retrieve', 'The handbook states that the T500 continuously records a full shift to encrypted storage so an authorized administrator can locate footage and create a formal evidence record even when the record button was not pressed.', [7], ['T500', 'Trusted Vault'], ['continuous-recording', 'recovery'], 'needs_verification', 'use_with_citation'],
  ['feature', 'privacy-mode', 'Privacy Mode', 'Privacy Mode allows an officer to temporarily suspend continuous recording for personal moments consistent with agency policy, while logging each activation in the device audit log.', [7], ['T500'], ['privacy', 'audit'], 'needs_verification', 'use_with_citation'],
  ['deployment', 'deployment-timeline', 'Deployment timeline', 'The handbook states that agencies can be fully operational within 30 days of contract execution and that hardware can ship within one week.', [7], ['T500 System'], ['deployment'], 'needs_verification', 'use_with_citation'],
  ['training', 'training', 'Training program', 'Standard training is included and delivered by video conference at train-the-trainer, end-user, supervisor, and system-administrator levels. The handbook states end-user training takes under 45 minutes.', [8], ['T500 System'], ['training'], 'needs_verification', 'use_with_citation'],
  ['support', 'warranty', 'Full-term hardware warranty', 'The handbook describes a hardware warranty covering cameras and docks for the full agreement term, including water-exposure failures up to submersion.', [8, 9], ['T500 System'], ['warranty'], 'needs_verification', 'use_with_citation'],
  ['support', 'replacement', 'Replacement commitment', 'The handbook describes RMA processing within 24 hours and replacement shipment within 72 hours after receipt of a faulty unit.', [8, 9], ['T500 System'], ['support', 'replacement'], 'needs_verification', 'use_with_citation'],
  ['support', 'availability', 'Platform availability commitment', 'The handbook states 99.9% monthly Trusted Vault availability on redundant multi-zone AWS infrastructure.', [6, 8, 9], ['Trusted Vault'], ['availability', 'SLA'], 'needs_verification', 'use_with_citation'],
  ['pricing', 'contract-pricing', 'Published contract pricing', 'The handbook lists annual per-camera rates of $600 for five-year prepaid, $660 for five-year annual payment, $720 for three-year prepaid, $780 for three-year annual payment, and $900 for one-year year-to-year.', [9], ['T500 System'], ['pricing'], 'needs_verification', 'use_with_citation'],
  ['pricing', 'included-items', 'All-inclusive pricing scope', 'Listed contract pricing includes cameras, standard eight-port docks, officer-choice standard mounts, Trusted Vault with unlimited storage and users, updates, full-term warranty, standard training, support, and shipping.', [7, 9], ['T500 System'], ['pricing', 'included'], 'needs_verification', 'use_with_citation'],
  ['pricing', 'redaction-pricing', 'Redaction pricing', 'The handbook lists a $300 annual base redaction package with three hours of Veritone-powered video and audio redaction, plus additional one-hour blocks at $100 per hour.', [6, 9], ['Trusted Vault'], ['pricing', 'redaction'], 'needs_verification', 'use_with_citation'],
  ['pricing', 'option-pricing', 'Accessory and training pricing', 'The handbook lists a single-bay dock at $295 one-time, magnetic quick-release mount at $30 one-time, and on-site training at travel cost plus $500 per day.', [9], ['T500 System'], ['pricing', 'options'], 'needs_verification', 'use_with_citation'],
  ['case-study', 'parker-county', 'Parker County Juvenile Probation case study', 'The handbook describes a July 2025 Parker County Juvenile Probation deployment and reports improved staff safety, fewer false complaints, improved family interactions, training benefits, and an estimated $100,000 annual staffing saving.', [10], ['T500', 'Trusted Vault'], ['case-study'], 'needs_verification', 'use_with_citation'],
  ['validation', 'officer-labs', 'OFFICER Labs field test', 'The handbook states that OFFICER Labs awarded the T500 a Tested / Field-Rated Seal of Approval and provides a source URL for the field test.', [10, 11], ['T500'], ['field-test', 'certification'], 'needs_verification', 'use_with_citation'],
  ['offer', 'free-field-test', 'Free field-test offer', 'The handbook offers no-charge field-test units so agencies can evaluate cameras, dock, and Trusted Vault in their own environment before commitment, plus a model body-camera policy and live Trusted Vault demonstration.', [11], ['T500 System'], ['demo', 'field-test'], 'needs_verification', 'use_with_citation'],
  ['company-history', 'founder-history', 'Founding-team industry history', 'The handbook attributes the T500 system to a team with prior Edesix, Vigilant Solutions, VaaS International, and Motorola Solutions experience, including body-camera engineering and public-safety technology leadership.', [1, 2, 3], ['Trusted Technology Solutions'], ['company', 'founders'], 'needs_verification', 'use_with_citation'],
  ['restricted-contact', 'reference-contacts', 'Agency reference contacts', 'The source document contains named agency references, personal work email addresses, and deployment details. These contacts are internal-only and must not be included in generated public content without separate permission.', [10, 11], ['T500 System'], ['contacts', 'references'], 'restricted', 'internal_only'],
  ['restricted-contact', 'sales-contacts', 'Sales and staff contacts', 'The source document contains direct phone numbers and email addresses for Trusted Technology personnel. Use only for authorized internal workflows; do not insert them into generated public content by default.', [1, 11, 12], ['Trusted Technology Solutions'], ['contacts'], 'restricted', 'internal_only'],
]

const buffer = await fs.readFile(sourcePath)
const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
const parser = new PDFParse({ data: buffer })
const parsed = await parser.getText()
await parser.destroy()

await mongoose.connect(process.env.MONGODB_URI)
try {
  const document = await KnowledgeDocument.findOneAndUpdate(
    { sha256 },
    {
      title: 'T500 System Capabilities Overview',
      originalFilename: path.basename(sourcePath),
      mimeType: 'application/pdf',
      sizeBytes: buffer.length,
      sha256,
      sourceType: 'internal_handbook',
      visibility: 'internal',
      approvalStatus: 'approved',
      products: ['T500', 'T500 Docking Station', 'Trusted Vault'],
      extractedText: parsed.text,
      fileData: buffer,
      pageCount: parsed.total || 12,
      approvedAt,
      approvedBy,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )

  for (const [category, key, title, content, sourcePages, products, tags, verificationStatus, contentUse] of facts) {
    await KnowledgeRecord.findOneAndUpdate(
      { sourceDocument: document._id, key },
      {
        sourceDocument: document._id,
        key,
        category,
        title,
        content,
        sourcePages,
        products,
        tags,
        visibility: verificationStatus === 'restricted' ? 'internal' : 'public',
        verificationStatus,
        contentUse,
        notes: verificationStatus === 'needs_verification'
          ? 'Imported from the approved handbook; verify current accuracy and cite the source before public use.'
          : '',
        approvedAt,
        approvedBy,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
  }

  await CompanyContext.findOneAndUpdate(
    {},
    {
      $setOnInsert: { companyName: 'Trusted Tech' },
      $addToSet: {
        activeProducts: { $each: ['T500', 'T500 Docking Station', 'Trusted Vault'] },
        targetCustomers: { $each: ['Law enforcement agencies', 'Public safety teams', 'Security teams', 'Small and mid-sized agencies'] },
        serviceLines: { $each: ['Body-worn camera systems', 'Digital evidence management'] },
      },
    },
    { upsert: true, new: true },
  )

  const products = [
    {
      slug: 't500-body-worn-camera',
      name: 'T500 Body Worn Camera',
      category: 'Body-worn camera',
      summary: 'Purpose-built body-worn camera for law enforcement, public safety, and security teams.',
      targetMarkets: ['Law enforcement', 'Public safety', 'Security'],
      features: ['1080p video', '12+ hour battery', '256 GB encrypted storage', 'RF-silent design', 'Vault Retrieve'],
    },
    {
      slug: 't500-docking-station',
      name: 'T500 Docking Station',
      category: 'Camera infrastructure',
      summary: 'Charging, firmware-management, and secure automatic-upload hub for T500 cameras.',
      targetMarkets: ['Law enforcement', 'Public safety', 'Security'],
      features: ['Eight-camera capacity', 'Automatic upload', 'Automatic firmware updates', 'Ethernet connection'],
    },
    {
      slug: 'trusted-vault',
      name: 'Trusted Vault',
      category: 'Digital evidence management',
      summary: 'Browser-based evidence management for T500 footage with search, retention, sharing, auditing, and redaction workflows.',
      targetMarkets: ['Law enforcement', 'Public safety', 'Security'],
      features: ['Evidence search', 'Role-based access', 'Retention rules', 'Audit trail', 'AI-assisted redaction'],
    },
  ]
  for (const product of products) {
    await Product.findOneAndUpdate(
      { slug: product.slug },
      { ...product, visibility: 'public' },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
  }

  console.log(JSON.stringify({
    documentId: document._id,
    sha256,
    records: facts.length,
    approved: facts.filter((fact) => fact[7] === 'approved').length,
    needsVerification: facts.filter((fact) => fact[7] === 'needs_verification').length,
    restricted: facts.filter((fact) => fact[7] === 'restricted').length,
  }))
} finally {
  await mongoose.disconnect()
}
