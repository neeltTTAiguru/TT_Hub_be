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
  skill: path.join(workspaceRoot, 'skills', 'market-researcher', 'SKILL.md'),
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
  const [
    workspaceInstructions,
    identity,
    soul,
    user,
    heartbeat,
    skill,
    pluginManifestRaw,
    pluginEntry,
    pluginReadme,
  ] = await Promise.all([
    readText(files.workspaceInstructions),
    readText(files.identity),
    readText(files.soul),
    readText(files.user),
    readText(files.heartbeat),
    readText(files.skill),
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
    skill,
    pluginManifest: JSON.parse(pluginManifestRaw),
    pluginEntry,
    pluginReadme,
  }
}

export async function listAgents() {
  const catalog = await loadCatalogFiles()
  const productAreas = getBulletItems(getSection(catalog.workspaceInstructions, 'Initial Product Areas'))
  const activeProducts = productAreas.filter((item) => item === 'Market Researcher')
  const pluginTools = getToolNames(catalog.pluginEntry)
  const pluginConfigFields = Object.keys(catalog.pluginManifest.configSchema?.properties ?? {})

  return [
    {
      id: 'market-researcher',
      name: 'Market Researcher',
      status: 'active',
      productArea: 'Market Researcher',
      summary: getFirstParagraph(getSection(catalog.skill, 'Purpose')),
      mission: getFirstParagraph(getSection(catalog.skill, 'Mission')),
      workflow: getBulletItems(getSection(catalog.skill, 'Workflow')),
      outputShape: getBulletItems(getSection(catalog.skill, 'Required Output Shape')),
      behaviorRules: getBulletItems(getSection(catalog.skill, 'Behavior Rules')),
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
        skill: files.skill,
        workspaceInstructions: files.workspaceInstructions,
        identity: files.identity,
        pluginManifest: files.pluginManifest,
        pluginEntry: files.pluginEntry,
        pluginReadme: files.pluginReadme,
      },
    },
  ]
}

export async function getAgentById(agentId) {
  if (agentId !== 'market-researcher') {
    return null
  }

  const [agent] = await listAgents()
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
        path: files.skill,
        content: catalog.skill,
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
