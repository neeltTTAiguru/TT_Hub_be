const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://trusted-fe-hub-agl8a.ondigitalocean.app',
]

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    return callback(new Error(`CORS blocked for origin: ${origin}`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-File-Name', 'X-File-Type'],
  // Without this the browser hides Content-Disposition from JavaScript on any
  // cross-origin response - which is every prod response, since the hub and the
  // API are different hosts. File downloads then silently lose the filename the
  // server chose and fall back to whatever the client guesses.
  exposedHeaders: ['Content-Disposition'],
  maxAge: 86400,
}

export { corsOptions, allowedOrigins }
