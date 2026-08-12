import crypto from 'node:crypto'
import PDFDocument from 'pdfkit'
import ContentOperationsRun from '../models/ContentOperationsRun.js'

function ascii(value) {
  return String(value ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '')
}

function plainMarkdown(value) {
  return ascii(value)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

// pdfkit only decodes JPEG and PNG. WordPress often serves generated images as AVIF or
// WebP, whose bytes make pdfkit throw "Unknown image format" and 500 the whole download.
// Sniff the magic bytes so we only ever hand pdfkit a format it can render.
function isPdfKitImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true // JPEG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true // PNG
  return false
}

export function createArticlePdfBuffer(title, markdown, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 58, right: 58, bottom: 62, left: 58 },
      bufferPages: true,
      info: {
        Title: title,
        Author: 'Trusted Technology',
        Subject: options.description || 'Trusted Technology Knowledge Center article',
      },
    })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const pageWidth = doc.page.width
    const contentWidth = pageWidth - 116
    const olive = '#777258'
    const charcoal = '#343630'
    const muted = '#6f726b'
    const pale = '#f1f1eb'

    doc.fillColor(olive).font('Helvetica-Bold').fontSize(9)
      .text('TRUSTED TECH KNOWLEDGE CENTER', 58, 52, { characterSpacing: 1.5 })
    doc.moveTo(58, 72).lineTo(pageWidth - 58, 72).lineWidth(1).strokeColor('#d7d6cd').stroke()
    doc.fillColor(charcoal).font('Helvetica-Bold').fontSize(29)
      .text(plainMarkdown(title), 58, 98, { width: contentWidth, lineGap: 2 })
    doc.fillColor(muted).font('Helvetica').fontSize(12)
      .text(plainMarkdown(options.description || ''), 58, doc.y + 17, { width: contentWidth, lineGap: 4 })

    let heroRendered = false
    if (isPdfKitImage(options.heroImage)) {
      const imageY = Math.max(doc.y + 28, 230)
      doc.save()
      try {
        doc.roundedRect(58, imageY, contentWidth, 260, 10).clip()
        doc.image(options.heroImage, 58, imageY, {
          cover: [contentWidth, 260],
          align: 'center',
          valign: 'center',
        })
        heroRendered = true
      } catch {
        heroRendered = false // corrupt/unsupported despite the signature — skip it
      } finally {
        doc.restore()
      }
      if (heroRendered) doc.y = imageY + 280
    }
    if (!heroRendered) {
      doc.y += 24
    }

    doc.fillColor(olive).font('Helvetica-Bold').fontSize(9)
      .text('TRUSTED TECHNOLOGY', 58, doc.y, { characterSpacing: 1.2 })
    doc.fillColor(muted).font('Helvetica').fontSize(9)
      .text(options.publishedAt ? `Published ${new Date(options.publishedAt).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })}` : 'Content Operations', 58, doc.y + 6)

    doc.addPage()

    let firstH1Skipped = false
    let inQuote = false
    for (const raw of String(markdown).replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.trim()
      if (!line) {
        inQuote = false
        continue
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/)
      if (heading) {
        const level = heading[1].length
        if (level === 1 && !firstH1Skipped) {
          firstH1Skipped = true
          continue
        }
        const size = level === 1 ? 23 : level === 2 ? 19 : level === 3 ? 15 : 12
        doc.moveDown(level <= 2 ? 1.15 : 0.75)
        doc.fillColor(charcoal).font('Helvetica-Bold').fontSize(size)
          .text(plainMarkdown(heading[2]), { width: contentWidth, lineGap: 2 })
        doc.moveDown(0.45)
        continue
      }

      if (line.startsWith('> ')) {
        if (!inQuote) {
          doc.moveDown(0.4)
          const quoteStart = doc.y
          const quoteHeight = doc.heightOfString(plainMarkdown(line.slice(2)), {
            width: contentWidth - 38,
            lineGap: 4,
          }) + 28
          doc.roundedRect(58, quoteStart, contentWidth, quoteHeight, 7).fill(pale)
          doc.rect(58, quoteStart, 4, quoteHeight).fill(olive)
          doc.y = quoteStart
          inQuote = true
        }
        doc.fillColor(charcoal).font('Helvetica-Bold').fontSize(11.5)
          .text(plainMarkdown(line.slice(2)), 79, doc.y + 14, {
            width: contentWidth - 42,
            lineGap: 4,
          })
        doc.y += 16
        continue
      }

      const bullet = line.match(/^[-*]\s+(.+)$/)
      const numbered = line.match(/^(\d+)\.\s+(.+)$/)
      if (bullet || numbered) {
        doc.fillColor(olive).font('Helvetica-Bold').fontSize(10)
          .text(numbered ? `${numbered[1]}.` : '•', 68, doc.y + 1, { width: 18 })
        doc.fillColor(charcoal).font('Helvetica').fontSize(10.8)
          .text(plainMarkdown((bullet || numbered)[numbered ? 2 : 1]), 88, doc.y - 12, {
            width: contentWidth - 30,
            lineGap: 3,
          })
        doc.moveDown(0.35)
        continue
      }

      doc.fillColor(charcoal).font('Helvetica').fontSize(10.8)
        .text(plainMarkdown(line), { width: contentWidth, lineGap: 4 })
      doc.moveDown(0.65)
    }

    const range = doc.bufferedPageRange()
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index)
      const previousBottomMargin = doc.page.margins.bottom
      doc.page.margins.bottom = 0
      doc.moveTo(58, 752).lineTo(pageWidth - 58, 752).lineWidth(0.6).strokeColor('#d7d6cd').stroke()
      doc.fillColor(muted).font('Helvetica').fontSize(8)
        .text('Trusted Technology • trustedtechnology.ai', 58, 762, {
          width: 350,
          lineBreak: false,
        })
      doc.text(String(index + 1), pageWidth - 88, 762, {
        width: 30,
        align: 'right',
        lineBreak: false,
      })
      doc.page.margins.bottom = previousBottomMargin
    }
    doc.end()
  })
}

function secret() {
  return process.env.CONTENT_DOWNLOAD_SECRET || process.env.HERMES_API_KEY || ''
}

export function createPdfDownloadToken(runId) {
  if (!secret()) throw Object.assign(new Error('PDF downloads are not configured.'), { statusCode: 503 })
  const payload = Buffer.from(JSON.stringify({ runId, expiresAt: Date.now() + 5 * 60 * 1000 })).toString('base64url')
  const signature = crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export async function resolvePdfDownload(token) {
  const [payload, signature] = String(token).split('.')
  if (!payload || !signature || !secret()) return null
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest()
  const supplied = Buffer.from(signature, 'base64url')
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null
  let data
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!data.runId || Number(data.expiresAt) < Date.now()) return null
  return ContentOperationsRun.findOne({
    runId: data.runId,
    article: { $ne: '' },
    'approval.article': true,
  })
}
