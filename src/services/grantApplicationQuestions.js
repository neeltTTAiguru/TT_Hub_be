import GrantOpportunity from '../models/GrantOpportunity.js'
import { ensureBrowserStarted, runBrowserCommand } from './browserResearch.js'

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function parseBrowserJson(raw) {
  let value = raw

  for (let index = 0; index < 3; index += 1) {
    if (value && typeof value === 'object') {
      return value
    }

    if (typeof value !== 'string') {
      return value
    }

    try {
      value = JSON.parse(value)
    } catch {
      return value
    }
  }

  return value
}

function isLoginLikeText(text) {
  return /\b(log in|login|sign in|register|create account|username|password|multi-factor|mfa|captcha)\b/i.test(text)
}

export async function readGrantApplicationQuestions({ opportunityId }) {
  const opportunity = await GrantOpportunity.findOne({ opportunityId })

  if (!opportunity) {
    const error = new Error('Grant opportunity was not found.')
    error.statusCode = 404
    throw error
  }

  const applicationUrl = compactWhitespace(opportunity.applicationUrl || opportunity.sourceUrl)

  if (!applicationUrl) {
    const error = new Error('Grant opportunity does not have an application URL.')
    error.statusCode = 400
    throw error
  }

  await ensureBrowserStarted()
  await runBrowserCommand(['open', applicationUrl])
  await runBrowserCommand(['wait', '--url', applicationUrl]).catch(() => {})
  await runBrowserCommand(['wait', '--fn', '() => document.body && document.body.innerText.length > 80']).catch(() => {})

  const raw = await runBrowserCommand([
    'evaluate',
    '--fn',
    `() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const labelFor = (input) => {
        const id = input.getAttribute('id')
        const ariaLabel = input.getAttribute('aria-label')
        const placeholder = input.getAttribute('placeholder')
        const name = input.getAttribute('name')
        const explicit = id ? document.querySelector(\`label[for="\${CSS.escape(id)}"]\`) : null
        const wrapped = input.closest('label')
        const nearby = input.closest('div, li, tr, fieldset, section')?.innerText
        return clean(ariaLabel || explicit?.innerText || wrapped?.innerText || placeholder || name || nearby)
      }
      const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
        .slice(0, 120)
        .map((field, index) => ({
          index,
          tagName: field.tagName.toLowerCase(),
          type: field.getAttribute('type') || field.tagName.toLowerCase(),
          name: field.getAttribute('name') || '',
          id: field.getAttribute('id') || '',
          required: Boolean(field.required || field.getAttribute('aria-required') === 'true'),
          label: labelFor(field),
          options: field.tagName.toLowerCase() === 'select'
            ? Array.from(field.querySelectorAll('option')).map((option) => clean(option.innerText)).filter(Boolean).slice(0, 40)
            : []
        }))
        .filter((field) => field.label || field.name || field.id)
      const questionText = Array.from(document.querySelectorAll('legend, label, h1, h2, h3, h4, p, li, th'))
        .map((node) => clean(node.innerText))
        .filter((text) => text.length > 8)
        .filter((text, index, list) => list.indexOf(text) === index)
        .slice(0, 180)
      return JSON.stringify({
        title: document.title,
        url: location.href,
        pageText: clean(document.body?.innerText || '').slice(0, 8000),
        fields,
        questionText
      })
    }`,
  ])

  const payload = parseBrowserJson(raw)
  const pageText = compactWhitespace(payload?.pageText || '')
  const fields = Array.isArray(payload?.fields) ? payload.fields : []
  const questionText = Array.isArray(payload?.questionText) ? payload.questionText : []
  const needsLogin = isLoginLikeText(pageText) && fields.some((field) => /password|username|email/i.test(`${field.type} ${field.name} ${field.label}`))

  return {
    opportunity,
    applicationUrl,
    page: {
      title: String(payload?.title || ''),
      url: String(payload?.url || applicationUrl),
    },
    needsLogin,
    message: needsLogin
      ? 'The application portal appears to require login or account creation before application questions are visible.'
      : '',
    questions: fields.map((field) => ({
      label: field.label,
      type: field.type,
      name: field.name,
      required: Boolean(field.required),
      options: Array.isArray(field.options) ? field.options : [],
    })),
    visibleQuestionText: questionText,
    capturedAt: new Date().toISOString(),
  }
}
