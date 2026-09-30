import zlib from 'zlib'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { readHermesSessionEmail } from './hermesDashboard.js'

/**
 * Serves Hermes Workspace (outsourc-e/hermes-workspace) through the Hub's own
 * origin, under /workspace.
 *
 * Same reason as the dashboard proxy: a cross-origin frame renders but cannot be
 * used, and the Hub's host (*.ondigitalocean.app, a public suffix) makes any
 * second app a different SITE, so Workspace's SameSite=Strict cookie would not
 * ride in the frame either.
 *
 * Unlike the dashboard it cannot sit at the root. Workspace asks for /api and
 * /assets absolutely -- ~240 call sites -- and the dashboard proxy already owns
 * both. So it is mounted under a prefix, and three things make the stock build
 * live there without a fork:
 *
 * 1. The prefix is stripped on the way in, so Workspace sees the paths it
 *    expects.
 * 2. HTML and CSS are rewritten on the way out: the preload tags, the router
 *    manifest's asset paths and CSS url(/...) all point under the prefix.
 * 3. One expression in the client bundle is rewritten. TanStack Start's
 *    hydration calls router.update({ basepath: TSS_ROUTER_BASEPATH }), which the
 *    stock build compiles to undefined -- and that silently resets the basepath
 *    Workspace's own hook set, so every page matched the 404 route.
 * 4. A small shim is injected as the first script in <head>. It sets Workspace's
 *    own basepath hook (window.__HERMES_WORKSPACE_BASEPATH__, read by its
 *    router) and routes the absolute URLs its code builds at runtime -- fetch,
 *    XHR, EventSource, WebSocket, and src/href on elements -- back under the
 *    prefix. Without it the first /api call would reach the Hermes dashboard.
 *
 * Gate: the Hermes dashboard's session cookie and allowlist, deliberately shared.
 * Workspace is a terminal and file editor on the droplet, so it fails closed
 * exactly as the dashboard does.
 *
 * Known gap: a hard `window.location.href = '/chat'` in Workspace cannot be
 * intercepted (location is not patchable) and lands on the dashboard's /chat.
 * There are three such spots, all "go back to chat" escape hatches.
 */

export const WORKSPACE_PREFIX = '/workspace'
const MARKER_HEADER = 'x-hermes-workspace'

function getTarget() {
  return String(process.env.HERMES_WORKSPACE_URL || '').trim().replace(/\/$/, '')
}

export function isHermesWorkspaceConfigured() {
  return Boolean(getTarget())
}

function ownsPath(pathname = '') {
  return pathname === WORKSPACE_PREFIX || pathname.startsWith(`${WORKSPACE_PREFIX}/`)
}

// Runs before any of Workspace's own scripts. Kept dependency-free and ES5-ish:
// it is injected as text, and a syntax error here blanks the whole app.
export const WORKSPACE_SHIM = `(function(){
  var B=${JSON.stringify(WORKSPACE_PREFIX)};
  window.__HERMES_WORKSPACE_BASEPATH__=B;
  function under(p){return p===B||p.indexOf(B+'/')===0||p.indexOf(B+'?')===0||p.indexOf(B+'#')===0}
  function fix(u){
    if(typeof u!=='string'){
      if(u&&typeof URL!=='undefined'&&u instanceof URL){var s=fix(u.href);return s===u.href?u:new URL(s)}
      return u;
    }
    if(u.charAt(0)==='/'&&u.charAt(1)!=='/'){return under(u)?u:B+u}
    if(!/^(https?|wss?):/i.test(u))return u;
    try{
      var x=new URL(u);
      if(x.host!==location.host||under(x.pathname))return u;
      x.pathname=B+x.pathname;return x.href;
    }catch(e){return u}
  }
  window.__hermesWorkspaceFix=fix;
  var f=window.fetch;
  if(f){window.fetch=function(i,o){
    if(typeof Request!=='undefined'&&i instanceof Request){var n=fix(i.url);if(n!==i.url)i=new Request(n,i);return f.call(this,i,o)}
    return f.call(this,fix(i),o);
  }}
  var xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=fix(u);return xo.apply(this,a)};
  function wrapCtor(name){
    var C=window[name];if(!C)return;
    var W=function(u,o){return o===undefined?new C(fix(u)):new C(fix(u),o)};
    W.prototype=C.prototype;
    for(var k in C){try{W[k]=C[k]}catch(e){}}
    ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k){if(k in C)try{Object.defineProperty(W,k,{value:C[k]})}catch(e){}});
    window[name]=W;
  }
  wrapCtor('EventSource');wrapCtor('WebSocket');
  if(navigator.sendBeacon){var sb=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return sb(fix(u),d)}}
  var wo=window.open;window.open=function(u){var a=[].slice.call(arguments);a[0]=fix(u);return wo.apply(window,a)};
  ['pushState','replaceState'].forEach(function(k){
    var h=history[k];history[k]=function(s,t,u){return u==null?h.call(history,s,t):h.call(history,s,t,fix(u))};
  });
  var props=[['HTMLScriptElement','src'],['HTMLLinkElement','href'],['HTMLImageElement','src'],
    ['HTMLSourceElement','src'],['HTMLMediaElement','src'],['HTMLIFrameElement','src'],
    ['HTMLAnchorElement','href'],['HTMLFormElement','action']];
  var attrFor={};
  props.forEach(function(p){
    var C=window[p[0]];if(!C)return;
    var d=Object.getOwnPropertyDescriptor(C.prototype,p[1]);if(!d||!d.set)return;
    Object.defineProperty(C.prototype,p[1],{configurable:true,enumerable:d.enumerable,get:d.get,
      set:function(v){return d.set.call(this,fix(v))}});
    attrFor[p[1]]=true;
  });
  // The splash screen is built as an innerHTML string, whose <img src="/...">
  // never passes through the setters above.
  var ih=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  if(ih&&ih.set){Object.defineProperty(Element.prototype,'innerHTML',{configurable:true,enumerable:ih.enumerable,get:ih.get,
    set:function(v){
      if(typeof v==='string')v=v.replace(/(\\s(?:src|href)=["'])\\/(?!\\/)/g,function(m,a,o,s){
        return s.substr(o+m.length,B.length)===B.slice(1)?m:a+B+'/'});
      return ih.set.call(this,v);
    }})}
  // Workspace registers /sw.js with scope '/'. On the Hub's origin that would
  // put a service worker in front of the whole Hub, not just /workspace.
  if(navigator.serviceWorker&&navigator.serviceWorker.register){
    navigator.serviceWorker.register=function(){return Promise.reject(new Error('Service workers are disabled inside the Hub.'))};
  }
  var sa=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(n,v){
    var l=String(n).toLowerCase();
    if((l==='src'||l==='href'||l==='action')&&typeof v==='string')v=fix(v);
    return sa.call(this,n,v);
  };
  // Workspace hydrates the whole document, <head> included, so a <script> React
  // did not render is a hydration mismatch (React #418). Gone before it looks.
  if(document.currentScript)document.currentScript.remove();
})();`

/** Point absolute paths in Workspace's HTML under the prefix, and inject the shim. */
export function rewriteWorkspaceHtml(html) {
  const P = WORKSPACE_PREFIX
  let out = String(html)
    // Attributes: preload tags, icons, manifest, stylesheet, og:image.
    .replace(/(\s(?:src|href|content|action)=")\/(?!\/)(?!workspace(?:[/"?#]))/g, `$1${P}/`)
    // Asset paths inside inline scripts -- the router manifest and the
    // `import("/assets/main-*.js")` bootstrap. Covers \"-escaped forms too.
    .replace(/(["'`])\/assets\//g, `$1${P}/assets/`)

  const tag = `<script>${WORKSPACE_SHIM}</script>`
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${out}`
  return out
}

export function rewriteWorkspaceCss(css) {
  return String(css).replace(/url\(\s*(["']?)\/(?!\/)(?!workspace\/)/g, `url($1${WORKSPACE_PREFIX}/`)
}

// How Vite inlines the unset build-time constant; see point 3 above.
const START_BASEPATH = /\{\}\.TSS_ROUTER_BASEPATH\b/g

export function rewriteWorkspaceJs(js) {
  return String(js).replace(START_BASEPATH, '(window.__HERMES_WORKSPACE_BASEPATH__||"/")')
}

export function rewriteWorkspaceLocation(location) {
  if (!location || !location.startsWith('/') || location.startsWith('//')) return location
  return ownsPath(location.split(/[?#]/)[0]) ? location : `${WORKSPACE_PREFIX}${location}`
}

function decode(buffer, encoding = '') {
  const kind = String(encoding).toLowerCase()
  if (kind === 'gzip') return zlib.gunzipSync(buffer)
  if (kind === 'br') return zlib.brotliDecompressSync(buffer)
  if (kind === 'deflate') return zlib.inflateSync(buffer)
  return buffer
}

/**
 * HTML, CSS and JS are buffered and rewritten -- all three are static or
 * server-rendered in one piece. Everything else is piped through untouched and unbuffered --
 * Workspace streams chat over SSE, and buffering would hold every token until
 * the response ended.
 */
function handleProxyResponse(proxyRes, req, res) {
  const headers = { ...proxyRes.headers, [MARKER_HEADER]: '1' }
  if (headers.location) headers.location = rewriteWorkspaceLocation(headers.location)

  const type = String(headers['content-type'] || '')
  const rewrite = type.includes('text/html')
    ? rewriteWorkspaceHtml
    : type.includes('text/css')
      ? rewriteWorkspaceCss
      : type.includes('javascript')
        ? rewriteWorkspaceJs
        : null

  if (!rewrite || req.method === 'HEAD') {
    res.writeHead(proxyRes.statusCode || 502, headers)
    proxyRes.pipe(res)
    return
  }

  const chunks = []
  proxyRes.on('data', (chunk) => chunks.push(chunk))
  proxyRes.on('error', () => res.destroy())
  proxyRes.on('end', () => {
    let body
    try {
      body = Buffer.from(rewrite(decode(Buffer.concat(chunks), headers['content-encoding']).toString('utf8')))
    } catch {
      res.writeHead(502, { 'content-type': 'text/plain', [MARKER_HEADER]: '1' })
      res.end('Hermes Workspace sent a response the Hub could not rewrite.')
      return
    }
    delete headers['content-encoding']
    delete headers['transfer-encoding']
    // The body changed, so the upstream validators no longer describe it.
    delete headers.etag
    headers['content-length'] = String(body.length)
    res.writeHead(proxyRes.statusCode || 200, headers)
    res.end(body)
  })
}

/**
 * The /workspace proxy and its cookie gate. Mount BEFORE requireAuth, helmet and
 * the body parser, for the same reasons as the dashboard proxy.
 */
export function createHermesWorkspaceMiddleware() {
  const target = getTarget()
  const proxy = target
    ? createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        xfwd: true,
        selfHandleResponse: true,
        // Express strips the mount path only under app.use('/workspace'); this
        // middleware is mounted at the root, so strip it here.
        pathRewrite: (path) => path.slice(WORKSPACE_PREFIX.length) || '/',
        on: { proxyRes: handleProxyResponse },
      })
    : null

  const middleware = (req, res, next) => {
    if (!ownsPath(req.path)) return next()
    // Unconfigured means invisible, as with the dashboard: fall through to the
    // 404 this path had before the proxy existed.
    if (!proxy) return next()
    if (!readHermesSessionEmail(req)) {
      return res.status(401).json({ message: 'No Hermes dashboard session.' })
    }
    // Bare /workspace would resolve Workspace's relative URLs one level up.
    if (req.path === WORKSPACE_PREFIX && req.method === 'GET') {
      const at = req.originalUrl.indexOf('?')
      return res.redirect(302, `${WORKSPACE_PREFIX}/${at >= 0 ? req.originalUrl.slice(at) : ''}`)
    }
    return proxy(req, res, next)
  }

  middleware.proxy = proxy
  return middleware
}

/** Upgrades bypass Express, so the gate is repeated here. */
export function attachHermesWorkspaceUpgrade(server, middleware) {
  if (!middleware?.proxy) return
  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0]
    if (!ownsPath(pathname)) return
    if (!readHermesSessionEmail(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    middleware.proxy.upgrade(req, socket, head)
  })
}
