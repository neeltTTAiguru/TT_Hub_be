import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { createHermesSession } from '../src/services/hermesDashboard.js'
import {
  WORKSPACE_SHIM,
  createHermesWorkspaceMiddleware,
  rewriteWorkspaceCss,
  rewriteWorkspaceHtml,
  rewriteWorkspaceJs,
  rewriteWorkspaceLocation,
} from '../src/services/hermesWorkspace.js'

test('points Workspace HTML under /workspace and injects the shim first', () => {
  const html = '<html><head><meta charSet="utf-8"/><link rel="modulepreload" href="/assets/main-1.js"/>'
    + '<link rel="icon" href="/claude-avatar.png"/><meta property="og:image" content="/cover.png"/>'
    + '<a href="//cdn.example/x">x</a><a href="/workspace/chat">c</a></head><body>'
    + '<script>$R={preloads:["/assets/main-1.js"],children:"import(\\"/assets/main-1.js\\")"}</script>'
    + '<script type="module">import("/assets/main-1.js")</script></body></html>'
  const out = rewriteWorkspaceHtml(html)

  assert.ok(out.startsWith(`<html><head><script>${WORKSPACE_SHIM}</script>`))
  assert.ok(out.includes('href="/workspace/assets/main-1.js"'))
  assert.ok(out.includes('href="/workspace/claude-avatar.png"'))
  assert.ok(out.includes('content="/workspace/cover.png"'))
  assert.ok(out.includes('preloads:["/workspace/assets/main-1.js"]'))
  assert.ok(out.includes('import(\\"/workspace/assets/main-1.js\\")'))
  assert.ok(out.includes('import("/workspace/assets/main-1.js")'))
  // Protocol-relative and already-prefixed URLs are left alone.
  assert.ok(out.includes('href="//cdn.example/x"'))
  assert.ok(out.includes('href="/workspace/chat"'))
  assert.ok(!out.includes('/workspace/workspace/'))
})

test('rewrites root-relative CSS urls only', () => {
  const css = 'a{background:url(/world.png)}b{background:url("/x.png")}c{mask:url(%23n)}d{background:url(//cdn/x)}'
  assert.equal(
    rewriteWorkspaceCss(css),
    'a{background:url(/workspace/world.png)}b{background:url("/workspace/x.png")}c{mask:url(%23n)}d{background:url(//cdn/x)}',
  )
})

test('keeps redirects inside /workspace', () => {
  assert.equal(rewriteWorkspaceLocation('/login?next=/chat'), '/workspace/login?next=/chat')
  assert.equal(rewriteWorkspaceLocation('/workspace/chat'), '/workspace/chat')
  assert.equal(rewriteWorkspaceLocation('https://elsewhere.example/x'), 'https://elsewhere.example/x')
})

test("restores Workspace's basepath after TanStack Start hydration resets it", () => {
  assert.equal(
    rewriteWorkspaceJs('e.update({basepath:{}.TSS_ROUTER_BASEPATH,serializationAdapters:t})'),
    'e.update({basepath:(window.__HERMES_WORKSPACE_BASEPATH__||"/"),serializationAdapters:t})',
  )
})

test('the shim parses', () => {
  assert.doesNotThrow(() => new Function(WORKSPACE_SHIM))
})

async function listen(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

test('proxies behind the dashboard cookie, strips the prefix and rewrites HTML', async (t) => {
  const seen = []
  const upstream = await listen((req, res) => {
    seen.push(req.url)
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><head><link href="/assets/a.js"></head><body></body></html>')
  })
  t.after(() => upstream.server.close())

  const saved = { ...process.env }
  t.after(() => { process.env = saved })
  process.env.HERMES_WORKSPACE_URL = upstream.base
  process.env.HERMES_DASHBOARD_URL = ''
  process.env.HERMES_DASHBOARD_SESSION_SECRET = 'test-secret'
  process.env.HERMES_DASHBOARD_ALLOWED_EMAILS = 'ok@example.com'

  const app = express()
  app.use(createHermesWorkspaceMiddleware())
  app.post('/hermes-session', (req, _res, next) => {
    req.authEmail = req.headers['x-test-email']
    next()
  }, createHermesSession)
  const hub = await listen(app)
  t.after(() => hub.server.close())

  // No cookie: refused, and nothing reaches Workspace.
  const refused = await fetch(`${hub.base}/workspace/`)
  assert.equal(refused.status, 401)
  assert.equal(seen.length, 0)

  // A session for an address outside the allowlist is never minted.
  const outsider = await fetch(`${hub.base}/hermes-session`, { method: 'POST', headers: { 'x-test-email': 'no@example.com' } })
  assert.equal(outsider.status, 403)

  // The session mints with only HERMES_WORKSPACE_URL configured.
  const minted = await fetch(`${hub.base}/hermes-session`, { method: 'POST', headers: { 'x-test-email': 'ok@example.com' } })
  assert.equal(minted.status, 200)
  const cookie = minted.headers.get('set-cookie').split(';')[0]

  const bare = await fetch(`${hub.base}/workspace`, { headers: { cookie }, redirect: 'manual' })
  assert.equal(bare.status, 302)
  assert.equal(bare.headers.get('location'), '/workspace/')

  const page = await fetch(`${hub.base}/workspace/chat?x=1`, { headers: { cookie } })
  assert.equal(page.headers.get('x-hermes-workspace'), '1')
  const body = await page.text()
  assert.ok(body.includes('href="/workspace/assets/a.js"'))
  assert.ok(body.includes('__HERMES_WORKSPACE_BASEPATH__'))

  const api = await fetch(`${hub.base}/workspace/api/ping`, { headers: { cookie } })
  assert.deepEqual(await api.json(), { ok: true })
  assert.deepEqual(seen, ['/chat?x=1', '/api/ping'])

  // Paths outside the prefix are not the Workspace proxy's.
  const other = await fetch(`${hub.base}/workspacex`, { headers: { cookie } })
  assert.equal(other.status, 404)
})
