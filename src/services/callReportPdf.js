import PDFDocument from 'pdfkit'

/**
 * The house palette, matching the article PDF the Knowledge Center already
 * hands out. Two documents from the same company printed side by side should
 * not look like they came from two companies.
 */
const OLIVE = '#777258'
const CHARCOAL = '#343630'
const MUTED = '#6f726b'
const PALE = '#f1f1eb'
const RULE = '#d7d6cd'
const GREEN = '#5c7a52'

const MARGIN = 58
const CONTENT_WIDTH = 496
const FOOTER_Y = 752
/** Where a block has to stop and take the next page. */
const PAGE_BOTTOM = 726

/**
 * Helvetica is WinAnsi-encoded, and a smart quote pasted out of a chief's email
 * into a call note renders as a black square or throws. Notes are typed by
 * hand at speed, so this is not a theoretical case.
 */
function ascii(value) {
  return String(value ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '')
}

function plain(value) {
  return ascii(value)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

const number = (value) => Number(value || 0).toLocaleString('en-US')

const LONG_DATE = { day: 'numeric', month: 'long', year: 'numeric' }

/** A date printed in the report's own timezone, not the server's. */
function formatDate(value, timezone, options = LONG_DATE) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-GB', { ...options, timeZone: timezone })
}

/** "8 - 10 September 2026", collapsing the parts both ends share. */
function formatPeriod(period) {
  const from = formatDate(period.from, period.timezone)
  const to = formatDate(period.to, period.timezone)
  if (!from || !to) return ''
  if (from === to) return from
  const [fromDay, fromMonth, fromYear] = from.split(' ')
  const [toDay, toMonth, toYear] = to.split(' ')
  if (fromYear === toYear && fromMonth === toMonth) return `${fromDay} - ${toDay} ${toMonth} ${toYear}`
  if (fromYear === toYear) return `${fromDay} ${fromMonth} - ${toDay} ${toMonth} ${toYear}`
  return `${from} - ${to}`
}

/** Take the next page rather than run a block off the bottom of this one. */
function ensureSpace(doc, needed) {
  if (doc.y + needed > PAGE_BOTTOM) {
    doc.addPage()
    doc.y = MARGIN
  }
}

/**
 * A heading, and enough of the page left under it to be worth reading.
 *
 * The lookahead is what stops "Agencies worked" sitting alone at the foot of a
 * page with its table overleaf.
 */
function sectionHeading(doc, text, subtitle = '') {
  ensureSpace(doc, (subtitle ? 62 : 48) + 46)
  doc.moveDown(0.2)
  const y = doc.y
  doc.fillColor(CHARCOAL).font('Helvetica-Bold').fontSize(14).text(plain(text), MARGIN, y, {
    width: CONTENT_WIDTH,
  })
  if (subtitle) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(plain(subtitle), MARGIN, doc.y + 2, {
      width: CONTENT_WIDTH,
    })
  }
  doc
    .moveTo(MARGIN, doc.y + 6)
    .lineTo(MARGIN + CONTENT_WIDTH, doc.y + 6)
    .lineWidth(0.8)
    .strokeColor(RULE)
    .stroke()
  doc.y += 16
}

/**
 * Four figures across the page.
 *
 * The whole report in one glance, because most readers of a call report read
 * exactly this and the summary paragraph.
 */
function kpiRow(doc, tiles) {
  const height = 62
  ensureSpace(doc, height + 12)
  const gap = 8
  const width = (CONTENT_WIDTH - gap * (tiles.length - 1)) / tiles.length
  const top = doc.y
  tiles.forEach((tile, index) => {
    const x = MARGIN + index * (width + gap)
    doc.roundedRect(x, top, width, height, 7).fill(PALE)
    doc
      .fillColor(tile.accent || CHARCOAL)
      .font('Helvetica-Bold')
      .fontSize(23)
      .text(plain(tile.value), x + 12, top + 12, { width: width - 24, lineBreak: false })
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text(plain(tile.label).toUpperCase(), x + 12, top + 40, {
        width: width - 20,
        characterSpacing: 0.6,
        lineBreak: false,
      })
  })
  doc.y = top + height + 14
}

/**
 * Calls per day as bars.
 *
 * Days with nothing on them are drawn as empty slots on purpose - the gap
 * between Friday and Tuesday is the part a manager is looking for, and a chart
 * that only plots the days somebody dialled hides it.
 */
function dayChart(doc, days, timezone) {
  if (!days.length) return
  const height = 96
  ensureSpace(doc, height + 34)
  const top = doc.y
  const peak = Math.max(...days.map((day) => day.calls), 1)
  const slot = CONTENT_WIDTH / days.length
  const barWidth = Math.max(3, Math.min(28, slot - 6))
  // Every label at 30 bars is a grey smear; thin them until they can be read.
  const labelEvery = Math.ceil(days.length / 12)

  doc.moveTo(MARGIN, top + height).lineTo(MARGIN + CONTENT_WIDTH, top + height).lineWidth(0.8)
    .strokeColor(RULE).stroke()

  days.forEach((day, index) => {
    const x = MARGIN + index * slot + (slot - barWidth) / 2
    const barHeight = Math.round((day.calls / peak) * (height - 16))
    if (day.calls) {
      doc.rect(x, top + height - barHeight, barWidth, barHeight).fill(OLIVE)
      // The darker foot of the bar is the share that reached a human.
      const reached = Math.round((day.conversations / peak) * (height - 16))
      if (reached) doc.rect(x, top + height - reached, barWidth, reached).fill(GREEN)
      doc.fillColor(CHARCOAL).font('Helvetica-Bold').fontSize(7)
        .text(number(day.calls), x - 6, top + height - barHeight - 10, {
          width: barWidth + 12,
          align: 'center',
          lineBreak: false,
        })
    }
    if (index % labelEvery === 0) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(7)
        .text(formatDate(`${day.date}T12:00:00Z`, 'UTC', { day: 'numeric', month: 'short' }), x - 12, top + height + 5, {
          width: barWidth + 24,
          align: 'center',
          lineBreak: false,
        })
    }
  })

  doc.fillColor(MUTED).font('Helvetica').fontSize(8)
    .text(`Olive: calls logged. Green: calls that reached a person. Days shown in ${timezone}.`,
      MARGIN, top + height + 18, { width: CONTENT_WIDTH })
  doc.y = top + height + 34
}

/** Outcomes as proportional bars - the shape of a week, not just its size. */
function outcomeBars(doc, rows, totalCalls) {
  if (!rows.length) return
  const rowHeight = 18
  rows.forEach((row) => {
    ensureSpace(doc, rowHeight + 4)
    const y = doc.y
    const share = totalCalls ? row.calls / totalCalls : 0
    const labelWidth = 190
    const trackWidth = CONTENT_WIDTH - labelWidth - 58
    doc.fillColor(CHARCOAL).font('Helvetica').fontSize(9.5)
      .text(plain(row.outcome), MARGIN, y + 2, { width: labelWidth - 8, lineBreak: false })
    doc.roundedRect(MARGIN + labelWidth, y + 2, trackWidth, 10, 3).fill(PALE)
    if (share > 0) {
      doc.roundedRect(MARGIN + labelWidth, y + 2, Math.max(2, trackWidth * share), 10, 3).fill(OLIVE)
    }
    doc.fillColor(CHARCOAL).font('Helvetica-Bold').fontSize(9)
      .text(`${number(row.calls)}`, MARGIN + labelWidth + trackWidth + 8, y + 2, {
        width: 26,
        align: 'right',
        lineBreak: false,
      })
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(`${Math.round(share * 100)}%`, MARGIN + labelWidth + trackWidth + 36, y + 3, {
        width: 22,
        align: 'right',
        lineBreak: false,
      })
    doc.y = y + rowHeight
  })
  doc.y += 6
}

/**
 * A plain table.
 *
 * Columns are given a width and an alignment and nothing else; a call report
 * that needed a grid engine would be a sign it was trying to be a spreadsheet,
 * and the spreadsheet export already exists.
 */
function table(doc, columns, rows) {
  if (!rows.length) return
  ensureSpace(doc, 46)
  const header = doc.y
  doc.fillColor(OLIVE).font('Helvetica-Bold').fontSize(8)
  let x = MARGIN
  columns.forEach((column) => {
    doc.text(plain(column.label).toUpperCase(), x, header, {
      width: column.width,
      align: column.align || 'left',
      characterSpacing: 0.5,
      lineBreak: false,
    })
    x += column.width
  })
  doc.moveTo(MARGIN, header + 12).lineTo(MARGIN + CONTENT_WIDTH, header + 12).lineWidth(0.8)
    .strokeColor(RULE).stroke()
  doc.y = header + 18

  rows.forEach((row) => {
    const cells = columns.map((column) => plain(column.value(row)))
    const heights = columns.map((column, index) =>
      doc.font('Helvetica').fontSize(9).heightOfString(cells[index], { width: column.width - 8 }),
    )
    const rowHeight = Math.max(14, Math.ceil(Math.max(...heights)) + 6)
    ensureSpace(doc, rowHeight + 2)
    const y = doc.y
    let cellX = MARGIN
    columns.forEach((column, index) => {
      doc
        .fillColor(column.strong ? CHARCOAL : MUTED)
        .font(column.strong ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9)
        .text(cells[index], cellX, y, {
          width: column.width - 8,
          align: column.align || 'left',
        })
      cellX += column.width
    })
    doc.y = y + rowHeight
    doc.moveTo(MARGIN, doc.y - 3).lineTo(MARGIN + CONTENT_WIDTH, doc.y - 3).lineWidth(0.4)
      .strokeColor('#e8e7df').stroke()
  })
  doc.y += 10
}

/** Hermes replies in markdown; this is the subset he is asked to use. */
function renderNarrative(doc, markdown) {
  for (const raw of String(markdown).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,4}\s+(.+)$/)
    if (heading) {
      sectionHeading(doc, heading[1])
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    const numbered = line.match(/^(\d+)\.\s+(.+)$/)
    if (bullet || numbered) {
      const text = plain((bullet || numbered)[numbered ? 2 : 1])
      const height = doc.font('Helvetica').fontSize(10).heightOfString(text, {
        width: CONTENT_WIDTH - 30,
        lineGap: 3,
      })
      ensureSpace(doc, height + 8)
      const y = doc.y
      doc.fillColor(OLIVE).font('Helvetica-Bold').fontSize(10)
        .text(numbered ? `${numbered[1]}.` : '\u2022', MARGIN + 10, y, { width: 16, lineBreak: false })
      doc.fillColor(CHARCOAL).font('Helvetica').fontSize(10)
        .text(text, MARGIN + 30, y, { width: CONTENT_WIDTH - 30, lineGap: 3 })
      doc.y += 4
      continue
    }
    const text = plain(line)
    const height = doc.font('Helvetica').fontSize(10).heightOfString(text, {
      width: CONTENT_WIDTH,
      lineGap: 4,
    })
    ensureSpace(doc, Math.min(height, 120) + 8)
    doc.fillColor(CHARCOAL).font('Helvetica').fontSize(10)
      .text(text, MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 4 })
    doc.moveDown(0.5)
  }
}

/**
 * The call activity report.
 *
 * The counted figures come first and the written summary sits underneath them,
 * deliberately: the tables are what the report is accountable for, and Hermes
 * is quoting them rather than the other way round. When he cannot be reached
 * the document still prints in full, minus the prose.
 */
export function createCallReportPdfBuffer(stats, options = {}) {
  return new Promise((resolve, reject) => {
    const timezone = stats.period?.timezone || 'UTC'
    const periodLabel = formatPeriod(stats.period || {})
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, right: MARGIN, bottom: 62, left: MARGIN },
      bufferPages: true,
      info: {
        Title: `Call activity report - ${periodLabel}`,
        Author: 'Trusted Technology',
        Subject: options.scopeLabel || 'Agency map call activity',
      },
    })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    const totals = stats.totals || {}

    doc.fillColor(OLIVE).font('Helvetica-Bold').fontSize(9)
      .text('TRUSTED TECH - AGENCY MAP', MARGIN, 52, { characterSpacing: 1.5 })
    doc.moveTo(MARGIN, 72).lineTo(MARGIN + CONTENT_WIDTH, 72).lineWidth(1).strokeColor(RULE).stroke()
    doc.fillColor(CHARCOAL).font('Helvetica-Bold').fontSize(29)
      .text('Call activity report', MARGIN, 94, { width: CONTENT_WIDTH })
    doc.fillColor(MUTED).font('Helvetica').fontSize(12)
      .text(`${periodLabel} - ${totals.days || 1} ${totals.days === 1 ? 'day' : 'days'}`,
        MARGIN, doc.y + 6, { width: CONTENT_WIDTH })
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
      .text(plain(options.scopeLabel || 'All agencies'), MARGIN, doc.y + 8, { width: CONTENT_WIDTH })
    doc.fillColor(MUTED).font('Helvetica').fontSize(9)
      .text(
        `Generated ${formatDate(new Date(), timezone)}${options.generatedBy ? ` for ${plain(options.generatedBy)}` : ''}`,
        MARGIN,
        doc.y + 2,
        { width: CONTENT_WIDTH },
      )

    doc.y += 18
    kpiRow(doc, [
      { label: 'Calls logged', value: number(totals.calls) },
      { label: 'Agencies rung', value: number(totals.agenciesCalled) },
      { label: 'Reached a person', value: number(totals.conversations), accent: GREEN },
      { label: 'Decision makers', value: number(totals.decisionMakers), accent: GREEN },
    ])
    kpiRow(doc, [
      { label: 'Connect rate', value: `${totals.connectRate || 0}%` },
      { label: 'Calls a day', value: String(totals.callsPerDay ?? 0) },
      { label: 'First contacts', value: number(totals.firstContacts) },
      { label: 'Call-backs booked', value: number(totals.followUps) },
    ])

    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
      .text(
        `${number(totals.agenciesCalled)} of ${number(totals.agenciesInScope)} agencies in this territory were rung in this period. ` +
          'A conversation is any call that reached a human being - a decision maker, a gatekeeper, or somebody who told us no.',
        MARGIN,
        doc.y,
        { width: CONTENT_WIDTH, lineGap: 2 },
      )
    doc.y += 12

    if (!totals.calls) {
      sectionHeading(doc, 'No calls in this period')
      doc.fillColor(CHARCOAL).font('Helvetica').fontSize(10.5)
        .text(
          'Nobody logged a call against this territory between these dates. Either the calling has not started ' +
            'here yet, or the calls were made and not written down - the map cannot tell those apart.',
          MARGIN,
          doc.y,
          { width: CONTENT_WIDTH, lineGap: 4 },
        )
      finish(doc, periodLabel)
      return
    }

    sectionHeading(doc, 'Calls per day')
    dayChart(doc, stats.byDay || [], timezone)

    sectionHeading(doc, 'How the calls went')
    outcomeBars(doc, stats.byOutcome || [], totals.calls)

    if (options.narrative) {
      renderNarrative(doc, options.narrative)
    } else if (options.narrativeError) {
      sectionHeading(doc, 'Summary')
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(10)
        .text(
          `The written summary could not be produced this time (${plain(options.narrativeError)}). ` +
            'Every figure in this report was counted from the call log itself and is unaffected.',
          MARGIN,
          doc.y,
          { width: CONTENT_WIDTH, lineGap: 3 },
        )
      doc.moveDown(0.6)
    }

    if ((stats.byRep || []).length) {
      sectionHeading(doc, 'Who made the calls')
      table(
        doc,
        [
          { label: 'Caller', width: 214, value: (row) => row.rep, strong: true },
          { label: 'Calls', width: 62, align: 'right', value: (row) => number(row.calls) },
          { label: 'Agencies', width: 70, align: 'right', value: (row) => number(row.agencies) },
          { label: 'Reached', width: 70, align: 'right', value: (row) => number(row.conversations) },
          { label: 'Dec. makers', width: 80, align: 'right', value: (row) => number(row.decisionMakers) },
        ],
        stats.byRep,
      )
    }

    if ((stats.byState || []).length > 1) {
      sectionHeading(doc, 'Where the calling happened')
      table(
        doc,
        [
          { label: 'State', width: 216, value: (row) => row.state, strong: true },
          { label: 'Calls', width: 92, align: 'right', value: (row) => number(row.calls) },
          { label: 'Agencies', width: 94, align: 'right', value: (row) => number(row.agencies) },
          { label: 'Reached', width: 94, align: 'right', value: (row) => number(row.conversations) },
        ],
        stats.byState,
      )
    }

    if ((stats.topAgencies || []).length) {
      sectionHeading(doc, 'Agencies worked', 'Most calls first, then most recent.')
      table(
        doc,
        [
          { label: 'Agency', width: 236, value: (row) => row.name, strong: true },
          { label: 'State', width: 50, value: (row) => row.state },
          { label: 'Calls', width: 52, align: 'right', value: (row) => number(row.calls) },
          { label: 'Reached', width: 62, align: 'right', value: (row) => number(row.conversations) },
          {
            label: 'Last call',
            width: 96,
            align: 'right',
            value: (row) => formatDate(row.lastCalledAt, timezone, { day: 'numeric', month: 'short' }),
          },
        ],
        stats.topAgencies,
      )
    }

    if ((stats.followUps || []).length) {
      sectionHeading(doc, 'Call-backs booked', 'Promised on a call in this period.')
      table(
        doc,
        [
          {
            label: 'Due',
            width: 74,
            strong: true,
            value: (row) => formatDate(row.followUpAt, timezone, { day: 'numeric', month: 'short' }),
          },
          { label: 'Agency', width: 216, value: (row) => row.name },
          { label: 'Contact', width: 110, value: (row) => row.contactName || '-' },
          { label: 'Owner', width: 96, align: 'right', value: (row) => row.loggedBy },
        ],
        stats.followUps,
      )
    }

    finish(doc, periodLabel)
  })
}

/** Rule, wordmark and page numbers on every page, added once at the end. */
function finish(doc, periodLabel) {
  const range = doc.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index)
    const previousBottomMargin = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.moveTo(MARGIN, FOOTER_Y).lineTo(MARGIN + CONTENT_WIDTH, FOOTER_Y).lineWidth(0.6)
      .strokeColor(RULE).stroke()
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(`Trusted Technology - call activity, ${periodLabel}`, MARGIN, FOOTER_Y + 10, {
        width: 400,
        lineBreak: false,
      })
    doc.text(String(index + 1), MARGIN + CONTENT_WIDTH - 30, FOOTER_Y + 10, {
      width: 30,
      align: 'right',
      lineBreak: false,
    })
    doc.page.margins.bottom = previousBottomMargin
  }
  doc.end()
}
