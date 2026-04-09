import mongoose from 'mongoose'
import dotenv from 'dotenv'
import CompanyContext from '../src/models/CompanyContext.js'
import Product from '../src/models/Product.js'
import PublicPage from '../src/models/PublicPage.js'
import ResearchRun from '../src/models/ResearchRun.js'

dotenv.config()

const publicPages = [
  {
    url: 'https://www.trustedtechnology.ai/',
    slug: 'home',
    title: 'Home - Trusted Technology Solution',
    pageType: 'home',
    summary:
      'Homepage positioning centers on the T500 body worn camera system and repeats the messaging theme of simple, secure, reliable, and affordable.',
    highlights: [
      'Public product navigation lists T500 Body Worn System, T500 Camera, T500 Dock, Trusted Vault, and TBOX-AI400.',
      'Homepage calls the T500 system a simple, secure, reliable, and affordable solution for agencies.',
      'Primary CTA is to contact Trusted Technology for more information or a quote.',
    ],
    rawText:
      'T500 Camera. SIMPLE. SECURE. RELIABLE. ALL-IN-ONE PRICING. The Trusted T500 Body Worn Camera System is a simple, secure, reliable, and affordable solution that fits your agency’s needs and will protect your team. Products include T500 Camera, T500 Dock, Trusted Vault, and TBOX-AI400. Contact us for more information or to request a quote.',
    sourceDomain: 'trustedtechnology.ai',
  },
  {
    url: 'https://www.trustedtechnology.ai/about',
    slug: 'about',
    title: 'About - Trusted Technology Solution',
    pageType: 'about',
    summary:
      'The About page says Trusted Technology is headquartered in Lemont, Illinois and focuses on body worn camera solutions for public safety and law enforcement.',
    highlights: [
      'Headquartered in Lemont, Illinois.',
      'Team history includes designing and delivering body worn camera solutions.',
      'Mission emphasizes protecting teams with solutions that fit agency needs and budget.',
    ],
    rawText:
      'Headquartered in Lemont, Illinois, we are a high-powered team with a history of designing and delivering successful body worn camera solutions to Public Safety and Law Enforcement. Our current focus is perfecting a compact camera design and creating a body worn camera system with the optimal combination of simplicity, security, reliability, and affordability. Our mission is to help protect your team by providing your agency a body worn camera solution that fits your needs and budget.',
    sourceDomain: 'trustedtechnology.ai',
  },
  {
    url: 'https://www.trustedtechnology.ai/products/',
    slug: 'products',
    title: 'Our Products - Trusted Technology Solution',
    pageType: 'products',
    summary:
      'The products page expands the T500 system with details for the camera, dock, and Trusted Vault platform.',
    highlights: [
      'T500 Camera is described as a wearable video solution for public safety and enterprise security.',
      'T500 Dock holds 8 cameras and auto-uploads to Trusted Vault.',
      'Trusted Vault highlights unlimited storage, search/export, chain of custody, and automated redaction availability.',
    ],
    rawText:
      'Body Worn Camera System. The Trusted T500 Body Worn Camera System is a simple, secure, reliable, and affordable solution. T500 Camera: a wearable video solution designed with reliability and ease of use; minimal footprint; ideal for both public safety and enterprise security. Details include size 2.9 x 1.9 x 1.3 in, weight 3.4 oz, full shift battery life, H.264 encoding, and full HD 1920 x 1080. T500 Dock: holds 8 cameras, desk or wall mount, auto-uploads to Trusted Vault. Trusted Vault: unlimited storage, assign/tag/search/export, protected chain of custody, customizable roles tags and retention policy, available with automated redaction.',
    sourceDomain: 'trustedtechnology.ai',
  },
  {
    url: 'https://www.trustedtechnology.ai/products/tbox',
    slug: 'tbox-ai400',
    title: 'TBOX - AI400 - Trusted Technology Solution',
    pageType: 'product',
    summary:
      'The TBOX-AI400 page positions the product as an AI computing device for law enforcement and enterprise mobile computing use cases.',
    highlights: [
      'Positioned for both law enforcement and enterprise applications.',
      'Claims robustness, scalability, AI developer support, flexibility, cost effectiveness, and fast security.',
      'Mentions NVIDIA Jetson support, Linux/OpenCV support, and NVIDIA Morpheus cybersecurity framework.',
    ],
    rawText:
      'TBOX-AI400. Cutting-edge, multi-function AI computing device designed to revolutionize mobile computing in both Law Enforcement and Enterprise applications. Robust: durable, low-cost, secure, mobile, multi-function AI computing device. Scalable: supports 1-4 Jetson NVIDIA SOM processing units. AI Possibilities: Linux based; OpenCV support for AI developers. Flexibility: supports COTS NVIDIA System on a Module. Cost Effective: displace over engineered and overpriced mobile communication units. Fast Security: runs NVIDIA Morpheus, a GPU-accelerated cybersecurity AI framework.',
    sourceDomain: 'trustedtechnology.ai',
  },
  {
    url: 'https://www.trustedtechnology.ai/products/tbox/specifications',
    slug: 'tbox-ai400-specifications',
    title: 'TRUSTED TECHNOLOGY SYSTEMS - TBOX AI400',
    pageType: 'specifications',
    summary:
      'The specification page provides hardware and I/O details for the TBOX-AI400 edge AI system.',
    highlights: [
      'Fanless edge AI system with NVIDIA Jetson Orin NX and up to 100 TOPS.',
      'Includes HDMI, Ethernet, SFP+, PoE ports, USB, and configurable RAID storage.',
      'Notes that the unit does not include LTE, 5G, or WiFi and does not contain civilian encryption.',
    ],
    rawText:
      'Fanless Edge AI System with NVIDIA Jetson Orin NX, 1 HDMI, 1 GbE WAN, 1 WAN Port SFP+, 4 Port GbE PoE, 2 Comm Terminal Ports, USB, and 2 SSD RAID configurable storage. Features include high AI computing performance, support for four 15W GbE PoEs for cameras, wide operating temperature, and built in super cap for power backup. The TBOX AI400 does not include LTE, 5G, or WiFi and does not transmit signals.',
    sourceDomain: 'trustedtechnology.ai',
  },
  {
    url: 'https://www.trustedtechnology.ai/contact-us/',
    slug: 'contact-us',
    title: 'Contact Us - Trusted Technology Solution',
    pageType: 'contact',
    summary:
      'The contact page provides public lead-routing details for inquiries and quotes.',
    highlights: [
      'Phone number shown publicly: 630-286-9139.',
      'Email address shown publicly: info@trustedtechnology.ai.',
      'Contact form collects organization and job-title information for routing.',
    ],
    rawText:
      'Contact Us. Thank you for your interest in Trusted. Please complete the form below for more information. Contact Phone Number: 630-286-9139. Our Email Address: info@trustedtechnology.ai. The form asks for first name, last name, email, phone, city, organization, and job title so the inquiry can be routed to the right person.',
    sourceDomain: 'trustedtechnology.ai',
  },
  {
    url: 'https://www.trustedtechnology.ai/careers/',
    slug: 'careers',
    title: 'Careers - Trusted Technology Solution',
    pageType: 'careers',
    summary:
      'The careers page frames Trusted Technology as a mission-driven company focused on safety and security from gun violence.',
    highlights: [
      'Mentions helping cities and communities be safe and secure from gun violence.',
      'Emphasizes passion for technology and services that help law enforcement partners protect communities.',
      'No active openings are listed on the page snapshot.',
    ],
    rawText:
      'Work With Us. Trusted Technology is an innovative company focused on helping cities and communities be safe and secure from gun violence. Employees are passionate about technology and services to help law enforcement partners protect their communities. Check back soon for open positions.',
    sourceDomain: 'trustedtechnology.ai',
  },
]

const products = [
  {
    slug: 't500-body-worn-system',
    name: 'T500 Body Worn System',
    category: 'body-worn-camera-system',
    summary:
      'A body worn camera system positioned as simple, secure, reliable, and affordable for agency deployments.',
    targetMarkets: ['Law enforcement agencies', 'Public safety organizations'],
    features: [
      'Simple deployment positioning',
      'Secure evidence workflow positioning',
      'Reliable body worn camera system',
      'Affordable all-in-one pricing message',
    ],
    claims: [
      'Fits your agency needs',
      'Protects your team',
      'Simple, secure, reliable, and affordable',
    ],
    sourceUrls: [
      'https://www.trustedtechnology.ai/',
      'https://www.trustedtechnology.ai/products/',
      'https://www.trustedtechnology.ai/about',
    ],
  },
  {
    slug: 't500-camera',
    name: 'T500 Camera',
    category: 'camera',
    summary:
      'A wearable video solution designed with reliability and ease of use for public safety and enterprise security.',
    targetMarkets: ['Public safety', 'Enterprise security'],
    features: ['Minimal footprint', 'Full shift battery life', 'H.264 encoding', 'Full HD video'],
    claims: ['Reliable and easy to use', 'Ideal for public safety and enterprise security'],
    specs: [
      { label: 'Size', value: '2.9 x 1.9 x 1.3 in' },
      { label: 'Weight', value: '3.4 oz' },
      { label: 'Battery', value: 'Full shift battery life' },
      { label: 'Encoding', value: 'H.264' },
      { label: 'Video', value: 'Full HD 1920 x 1080' },
    ],
    sourceUrls: ['https://www.trustedtechnology.ai/', 'https://www.trustedtechnology.ai/products/'],
  },
  {
    slug: 't500-dock',
    name: 'T500 Dock',
    category: 'dock',
    summary:
      'Docking hardware for the T500 system that holds eight cameras and uploads to Trusted Vault.',
    targetMarkets: ['Law enforcement agencies', 'Public safety organizations'],
    features: ['Holds 8 cameras', 'Desk mount', 'Wall mount', 'Auto-uploads to Trusted Vault'],
    claims: ['Supports streamlined camera management and upload workflow'],
    sourceUrls: ['https://www.trustedtechnology.ai/', 'https://www.trustedtechnology.ai/products/'],
  },
  {
    slug: 'trusted-vault',
    name: 'Trusted Vault',
    category: 'evidence-platform',
    summary:
      'Evidence workflow and storage platform associated with the T500 body worn camera system.',
    targetMarkets: ['Law enforcement agencies', 'Public safety organizations'],
    features: [
      'Unlimited storage',
      'Assign, tag, search, and export',
      'Protected chain of custody',
      'Customizable roles, tags, and retention policy',
      'Available with automated redaction',
    ],
    claims: ['Supports protected chain of custody and evidence management'],
    sourceUrls: ['https://www.trustedtechnology.ai/', 'https://www.trustedtechnology.ai/products/'],
  },
  {
    slug: 'tbox-ai400',
    name: 'TBOX-AI400',
    category: 'edge-ai-device',
    summary:
      'An AI-enabled mobile computing device positioned for law enforcement and enterprise applications.',
    targetMarkets: ['Law enforcement agencies', 'Enterprise mobile computing teams'],
    features: [
      'Durable, low-cost, secure mobile AI computing device',
      'Supports 1-4 Jetson NVIDIA SOM processing units',
      'Linux based with OpenCV support for developers',
      'Supports COTS NVIDIA system-on-module hardware',
      'Runs NVIDIA Morpheus cybersecurity framework',
    ],
    claims: [
      'Revolutionizes mobile computing for law enforcement and enterprise applications',
      'Displaces over engineered and overpriced mobile communication units',
    ],
    specs: [
      { label: 'AI Accelerator', value: 'NVIDIA Jetson Orin NX up to 100 TOPS' },
      { label: 'Ports', value: 'HDMI, Ethernet, SFP+, 4 PoE, USB, RS232' },
      { label: 'Storage', value: '2 SSD drives, RAID configurable, external NVMe support' },
      { label: 'Connectivity note', value: 'Does not include LTE, 5G, or WiFi' },
    ],
    sourceUrls: [
      'https://www.trustedtechnology.ai/products/tbox',
      'https://www.trustedtechnology.ai/products/tbox/specifications',
    ],
  },
]

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

async function upsertPublicPages() {
  await Promise.all(
    publicPages.map((page) =>
      PublicPage.findOneAndUpdate({ url: page.url }, page, {
        upsert: true,
        new: true,
        runValidators: true,
      }),
    ),
  )
}

async function upsertProducts() {
  await Promise.all(
    products.map((product) =>
      Product.findOneAndUpdate({ slug: product.slug }, product, {
        upsert: true,
        new: true,
        runValidators: true,
      }),
    ),
  )
}

async function upsertCompanyContext() {
  const companyUpdate = {
    companyName: 'Trusted Tech',
    companySummary:
      'Trusted Technology publicly presents itself as a provider of body-worn camera systems, evidence workflow tooling, and AI-enabled mobile computing solutions.',
    mission:
      'Public-facing messaging emphasizes simple, secure, reliable, and affordable solutions that protect teams, fit agency needs, and support public safety outcomes.',
    website: 'https://www.trustedtechnology.ai/',
    targetCustomers: [
      'Law enforcement agencies',
      'Public safety organizations',
      'Enterprise organizations with mobile computing or security needs',
    ],
    serviceLines: [
      'Body-worn camera systems',
      'Camera docking and upload workflows',
      'Evidence storage and management',
      'AI-enabled mobile and edge computing',
    ],
    activeProducts: ['Market Researcher'],
    researchPriorities: [
      'Track body-worn camera market positioning',
      'Monitor law enforcement technology competitors',
      'Watch AI-enabled mobile computing demand signals',
      'Monitor updates to trustedtechnology.ai public messaging',
    ],
    positioningNotes:
      'Public messaging repeatedly emphasizes simple, secure, reliable, and affordable. Public product footprint includes T500 Body Worn System, T500 Camera, T500 Dock, Trusted Vault, and TBOX-AI400. About page states the business is headquartered in Lemont, Illinois. Contact page publicly lists info@trustedtechnology.ai and 630-286-9139.',
  }

  let context = await CompanyContext.findOne().sort({ createdAt: 1 })

  if (!context) {
    context = await CompanyContext.create(companyUpdate)
  } else {
    Object.assign(context, companyUpdate)
    await context.save()
  }
}

async function upsertResearchRun() {
  const runUpdate = {
    objective:
      'Capture current public company facts, products, positioning, and public website pages from trustedtechnology.ai into Mongo for OpenClaw.',
    scope:
      'Public website pages reviewed: home, about, products, TBOX page, TBOX specification page, contact page, and careers page.',
    status: 'completed',
    requestedBy: 'openclaw-ingest',
    findings: [
      {
        summary:
          'Trusted Technology publicly positions itself around simple, secure, reliable, and affordable body worn camera solutions.',
        implication:
          'This is a core messaging spine that OpenClaw should treat as an externally visible positioning claim.',
        confidence: 'high',
        sources: [
          { label: 'Trusted Technology home page', url: 'https://www.trustedtechnology.ai/', sourceType: 'web' },
          { label: 'Trusted Technology About page', url: 'https://www.trustedtechnology.ai/about', sourceType: 'web' },
        ],
      },
      {
        summary:
          'The public product set spans cameras, docking, evidence workflow, and AI-enabled edge/mobile computing.',
        implication:
          'OpenClaw can reason about Trusted Tech as more than a single camera product and instead as a small platform portfolio.',
        confidence: 'high',
        sources: [
          { label: 'Trusted Technology products page', url: 'https://www.trustedtechnology.ai/products/', sourceType: 'web' },
          { label: 'TBOX-AI400 page', url: 'https://www.trustedtechnology.ai/products/tbox', sourceType: 'web' },
        ],
      },
      {
        summary:
          'The About and Careers pages emphasize public safety, law enforcement, and community protection outcomes.',
        implication:
          'Public safety mission language should be treated as part of the brand narrative and buyer context.',
        confidence: 'medium',
        sources: [
          { label: 'Trusted Technology About page', url: 'https://www.trustedtechnology.ai/about', sourceType: 'web' },
          { label: 'Trusted Technology careers page', url: 'https://www.trustedtechnology.ai/careers/', sourceType: 'web' },
        ],
      },
      {
        summary:
          'The TBOX-AI400 specification page adds a more technical hardware profile than the marketing pages alone.',
        implication:
          'OpenClaw can use both marketing and technical product descriptions when discussing TBOX-AI400.',
        confidence: 'high',
        sources: [
          {
            label: 'TBOX-AI400 specification page',
            url: 'https://www.trustedtechnology.ai/products/tbox/specifications',
            sourceType: 'web',
          },
        ],
      },
    ],
    recommendedNextSteps: [
      'Add public competitors in Mongo for body-worn camera and law-enforcement technology categories.',
      'Version public pages over time so messaging changes can be tracked historically.',
      'Add a source-library collection if you want richer source metadata beyond website pages.',
    ],
    reportSummary:
      'Trusted Tech public business data has been normalized into Mongo collections for company context, products, public pages, and a source-backed ingest run so OpenClaw can access the public business footprint directly.',
  }

  const title = 'Public website ingest: trustedtechnology.ai'
  const existingRun = await ResearchRun.findOne({ title, requestedBy: 'openclaw-ingest' }).sort({
    createdAt: -1,
  })

  if (!existingRun) {
    await ResearchRun.create({
      title,
      ...runUpdate,
    })
    return
  }

  Object.assign(existingRun, runUpdate)
  await existingRun.save()
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required')
  }

  await mongoose.connect(process.env.MONGODB_URI)

  await Promise.all([upsertPublicPages(), upsertProducts(), upsertCompanyContext()])
  await upsertResearchRun()

  const counts = {
    publicPages: await PublicPage.countDocuments(),
    products: await Product.countDocuments(),
    researchRuns: await ResearchRun.countDocuments({ requestedBy: 'openclaw-ingest' }),
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        counts,
      },
      null,
      2,
    ),
  )

  await mongoose.disconnect()
}

main().catch(async (error) => {
  console.error(error)

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect()
  }

  process.exit(1)
})
