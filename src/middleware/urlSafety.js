import net from 'node:net'

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map((part) => Number(part))

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b] = parts

  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.toLowerCase()
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')
}

function isBlockedHostname(hostname) {
  const normalized = hostname.toLowerCase()

  if (!normalized) return true
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized.endsWith('.local')) return true
  if (net.isIP(normalized) === 4 && isPrivateIpv4(normalized)) return true
  if (net.isIP(normalized) === 6 && isPrivateIpv6(normalized)) return true

  return false
}

function matchesAllowedHost(hostname, allowedHosts) {
  if (!allowedHosts?.length) {
    return true
  }

  const normalized = hostname.toLowerCase()
  return allowedHosts.some((host) => normalized === host || normalized.endsWith(`.${host}`))
}

export function validateExternalUrl(input, options = {}) {
  const trimmed = String(input || '').trim()

  if (!trimmed) {
    const error = new Error('A URL is required.')
    error.statusCode = 400
    throw error
  }

  let parsed

  try {
    parsed = new URL(trimmed)
  } catch {
    const error = new Error('Provide a valid absolute URL.')
    error.statusCode = 400
    throw error
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('Only http and https URLs are allowed.')
    error.statusCode = 400
    throw error
  }

  if (parsed.username || parsed.password) {
    const error = new Error('URLs with embedded credentials are not allowed.')
    error.statusCode = 400
    throw error
  }

  if (isBlockedHostname(parsed.hostname)) {
    const error = new Error('Local and private-network URLs are not allowed.')
    error.statusCode = 400
    throw error
  }

  if (!matchesAllowedHost(parsed.hostname, options.allowedHosts)) {
    const error = new Error(`URL must point to an allowed host: ${options.allowedHosts.join(', ')}.`)
    error.statusCode = 400
    throw error
  }

  return parsed.toString()
}
