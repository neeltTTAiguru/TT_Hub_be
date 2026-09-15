import { getGoogleAccessToken } from './googleAuth.js'

const DATA_API_BASE_URL = 'https://analyticsdata.googleapis.com/v1beta'
const ANALYTICS_READ_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'
const CACHE_TTL_MS = Number(process.env.GA4_CACHE_TTL_MS || 5 * 60 * 1000)

let snapshotCache = null

function getConfig() {
  return {
    propertyId: String(process.env.GA4_PROPERTY_ID || '').trim(),
    credentialsPath: String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim(),
  }
}

export function isGa4Configured() {
  const { propertyId, credentialsPath } = getConfig()
  return Boolean(propertyId && credentialsPath)
}

// The JWT signing lives in googleAuth.js now, shared with Search Console.
const getAccessToken = () => getGoogleAccessToken(ANALYTICS_READ_SCOPE)

async function runReport(body) {
  const { propertyId } = getConfig()
  if (!propertyId) throw new Error('GA4_PROPERTY_ID is not configured.')

  const response = await fetch(
    `${DATA_API_BASE_URL}/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    const message = detail?.error?.message || `GA4 Data API request failed (${response.status}).`
    throw new Error(message)
  }

  return response.json()
}

function metricMap(report) {
  const headers = report.metricHeaders || []
  const values = report.rows?.[0]?.metricValues || []
  return Object.fromEntries(headers.map((header, index) => [
    header.name,
    Number(values[index]?.value || 0),
  ]))
}

function dimensionRows(report, metricName) {
  return (report.rows || []).map((row) => ({
    name: row.dimensionValues?.[0]?.value || '(not set)',
    [metricName]: Number(row.metricValues?.[0]?.value || 0),
  }))
}

export async function getGa4Snapshot({ force = false } = {}) {
  if (!isGa4Configured()) return null
  if (!force && snapshotCache?.expiresAt > Date.now()) return snapshotCache.value

  const dateRanges = [{ startDate: '28daysAgo', endDate: 'yesterday' }]
  const [overviewReport, channelReport, pageReport] = await Promise.all([
    runReport({
      dateRanges,
      metrics: [
        { name: 'activeUsers' },
        { name: 'newUsers' },
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'eventCount' },
        { name: 'keyEvents' },
      ],
    }),
    runReport({
      dateRanges,
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 8,
    }),
    runReport({
      dateRanges,
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 10,
    }),
  ])

  const value = {
    propertyId: getConfig().propertyId,
    period: { startDate: '28daysAgo', endDate: 'yesterday' },
    overview: metricMap(overviewReport),
    topChannels: dimensionRows(channelReport, 'sessions'),
    topPages: dimensionRows(pageReport, 'views'),
    fetchedAt: new Date().toISOString(),
  }
  snapshotCache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
  return value
}

export async function getGa4ConnectionStatus() {
  if (!isGa4Configured()) return { status: 'not_configured' }

  try {
    const snapshot = await getGa4Snapshot()
    return {
      status: 'connected',
      propertyId: snapshot.propertyId,
      fetchedAt: snapshot.fetchedAt,
    }
  } catch (error) {
    return {
      status: 'error',
      propertyId: getConfig().propertyId,
      message: error.message,
    }
  }
}
