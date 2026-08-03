import { fetchJson } from './http.js'

const API_URL = 'https://api.openai.com/v1/responses'
const model = () => process.env.OPENAI_MODEL || 'gpt-4.1-mini'

function responseText(payload) {
  return (payload?.output ?? []).flatMap((item) => item?.content ?? [])
    .filter((item) => item?.type === 'output_text').map((item) => item.text).join('\n').trim()
}

export async function generateText({ instructions, input, jsonSchema }) {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY is required unless SEO_USE_MOCK_LLM=true.'), { statusCode: 503 })
  const body = { model: model(), instructions, input: String(input).slice(0, 100000) }
  if (jsonSchema) {
    body.text = { format: { type: 'json_schema', name: jsonSchema.name, strict: true, schema: jsonSchema.schema } }
  }
  const payload = await fetchJson(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  })
  const output = responseText(payload)
  if (!output) throw Object.assign(new Error('The model returned empty output.'), { statusCode: 502 })
  console.info(JSON.stringify({ event: 'seo_llm_usage', model: payload.model || model(), usage: payload.usage ?? null }))
  return output
}

export async function generateValidated(options, validate, generator = generateText) {
  const retries = Math.max(0, Number(process.env.SEO_MAX_MODEL_RETRIES ?? 1))
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return validate(JSON.parse(await generator(options)))
    } catch (error) {
      lastError = error
      console.warn(JSON.stringify({ event: 'seo_llm_validation_failed', attempt: attempt + 1, message: error.message }))
    }
  }
  throw Object.assign(new Error(`Model output validation failed: ${lastError?.message}`), { statusCode: 502 })
}
