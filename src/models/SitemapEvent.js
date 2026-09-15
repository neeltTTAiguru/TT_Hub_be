import mongoose from 'mongoose'

// One record per sitemap refresh: what triggered it, which URLs were checked,
// whether they were found, and whether Search Console / IndexNow were told.
// The Content Generator's sitemap panel reads the last few of these.
const sitemapEventSchema = new mongoose.Schema(
  {
    reason: { type: String, default: 'manual', trim: true },
    sitemapUrl: { type: String, default: '' },
    urls: { type: [String], default: [] },
    ok: { type: Boolean, default: false },
    summary: { type: String, default: '' },
    verification: { type: mongoose.Schema.Types.Mixed, default: null },
    searchConsole: { type: mongoose.Schema.Types.Mixed, default: null },
    indexNow: { type: mongoose.Schema.Types.Mixed, default: null },
    startedAt: { type: String, default: '' },
    finishedAt: { type: String, default: '' },
  },
  { timestamps: true },
)

sitemapEventSchema.index({ createdAt: -1 })

export default mongoose.model('SitemapEvent', sitemapEventSchema)
