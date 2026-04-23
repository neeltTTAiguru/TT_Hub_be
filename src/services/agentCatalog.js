import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const workspaceRoot = path.resolve(__dirname, '..', '..', '..')

const files = {
  workspaceInstructions: path.join(workspaceRoot, 'AGENTS.md'),
  identity: path.join(workspaceRoot, 'IDENTITY.md'),
  soul: path.join(workspaceRoot, 'SOUL.md'),
  user: path.join(workspaceRoot, 'USER.md'),
  heartbeat: path.join(workspaceRoot, 'HEARTBEAT.md'),
  pluginManifest: path.join(
    workspaceRoot,
    'openclaw-plugins',
    'trusted-tech-hub',
    'openclaw.plugin.json',
  ),
  pluginEntry: path.join(
    workspaceRoot,
    'openclaw-plugins',
    'trusted-tech-hub',
    'index.js',
  ),
  pluginReadme: path.join(
    workspaceRoot,
    'openclaw-plugins',
    'trusted-tech-hub',
    'README.md',
  ),
}

const agentDefinitions = [
  {
    id: 'trusted-tech-assistant',
    name: 'Trusted Tech Assistant',
    status: 'active',
    productArea: 'Market Researcher',
    skillPath: path.join(workspaceRoot, 'skills', 'trusted-tech-assistant', 'SKILL.md'),
  },
  {
    id: 'market-researcher',
    name: 'Market Researcher',
    status: 'active',
    productArea: 'Market Researcher',
    skillPath: path.join(workspaceRoot, 'skills', 'market-researcher', 'SKILL.md'),
  },
  {
    id: 'sam-gov-monitor',
    name: 'SAM.gov Monitor',
    status: 'planned',
    productArea: 'SAM.gov Monitor',
    skillPath: path.join(workspaceRoot, 'skills', 'sam-gov-monitor', 'SKILL.md'),
  },
  {
    id: 'rfp-response-agent',
    name: 'RFP Response Agent',
    status: 'planned',
    productArea: 'RFP Response',
    skillPath: path.join(workspaceRoot, 'skills', 'rfp-response-agent', 'SKILL.md'),
  },
  {
    id: 'linkedin-surfer',
    name: 'LinkedIn Surfer',
    status: 'planned',
    productArea: 'LinkedIn Signals',
    skillPath: path.join(workspaceRoot, 'skills', 'linkedin-surfer', 'SKILL.md'),
  },
]

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8')
}

function getSection(markdown, heading) {
  const expression = new RegExp(
    `^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`,
    'm',
  )
  const match = markdown.match(expression)
  return match?.[1]?.trim() ?? ''
}

function getBulletItems(markdownSection) {
  return markdownSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- /, '').trim())
}

function getFirstParagraph(markdownSection) {
  const normalized = markdownSection
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')

  return normalized.trim()
}

function getToolNames(pluginSource) {
  return Array.from(pluginSource.matchAll(/name:\s*'([^']+)'/g), (match) => match[1]).filter(
    (name) => !name.startsWith('trusted-tech-hub'),
  )
}

async function loadCatalogFiles() {
  const skills = Object.fromEntries(
    await Promise.all(
      agentDefinitions.map(async (agent) => [agent.id, await readText(agent.skillPath)]),
    ),
  )

  const [
    workspaceInstructions,
    identity,
    soul,
    user,
    heartbeat,
    pluginManifestRaw,
    pluginEntry,
    pluginReadme,
  ] = await Promise.all([
    readText(files.workspaceInstructions),
    readText(files.identity),
    readText(files.soul),
    readText(files.user),
    readText(files.heartbeat),
    readText(files.pluginManifest),
    readText(files.pluginEntry),
    readText(files.pluginReadme),
  ])

  return {
    workspaceInstructions,
    identity,
    soul,
    user,
    heartbeat,
    skills,
    pluginManifest: JSON.parse(pluginManifestRaw),
    pluginEntry,
    pluginReadme,
  }
}

export async function listAgents() {
  const catalog = await loadCatalogFiles()
  const productAreas = getBulletItems(getSection(catalog.workspaceInstructions, 'Initial Product Areas'))
  const activeProducts = productAreas
  const pluginTools = getToolNames(catalog.pluginEntry)
  const pluginConfigFields = Object.keys(catalog.pluginManifest.configSchema?.properties ?? {})

  return agentDefinitions.map((agent) => {
    const skill = catalog.skills[agent.id]

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      productArea: agent.productArea,
      summary: getFirstParagraph(getSection(skill, 'Purpose')),
      mission: getFirstParagraph(getSection(skill, 'Mission')),
      workflow: getBulletItems(getSection(skill, 'Workflow')),
      outputShape: getBulletItems(getSection(skill, 'Required Output Shape')),
      behaviorRules: getBulletItems(getSection(skill, 'Behavior Rules')),
      workspace: {
        purpose: getFirstParagraph(getSection(catalog.workspaceInstructions, 'Workspace Purpose')),
        activeProducts,
        trustedTechRules: getBulletItems(getSection(catalog.workspaceInstructions, 'Trusted Tech Rules')),
      },
      plugin: {
        id: catalog.pluginManifest.id,
        name: catalog.pluginManifest.name,
        description: catalog.pluginManifest.description,
        version: catalog.pluginManifest.version,
        tools: pluginTools,
        configFields: pluginConfigFields,
      },
      files: {
        skill: agent.skillPath,
        workspaceInstructions: files.workspaceInstructions,
        identity: files.identity,
        pluginManifest: files.pluginManifest,
        pluginEntry: files.pluginEntry,
        pluginReadme: files.pluginReadme,
      },
    }
  })
}

export async function getAgentById(agentId) {
  const agentDefinition = agentDefinitions.find((agent) => agent.id === agentId)

  if (!agentDefinition) {
    return null
  }

  const agents = await listAgents()
  const agent = agents.find((entry) => entry.id === agentId)
  const catalog = await loadCatalogFiles()

  return {
    ...agent,
    documents: {
      workspaceInstructions: {
        path: files.workspaceInstructions,
        content: catalog.workspaceInstructions,
      },
      identity: {
        path: files.identity,
        content: catalog.identity,
      },
      soul: {
        path: files.soul,
        content: catalog.soul,
      },
      user: {
        path: files.user,
        content: catalog.user,
      },
      heartbeat: {
        path: files.heartbeat,
        content: catalog.heartbeat,
      },
      skill: {
        path: agentDefinition.skillPath,
        content: catalog.skills[agentId],
      },
      pluginManifest: {
        path: files.pluginManifest,
        content: catalog.pluginManifest,
      },
      pluginReadme: {
        path: files.pluginReadme,
        content: catalog.pluginReadme,
      },
    },
  }
}
