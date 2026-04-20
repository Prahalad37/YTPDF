import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { formatTimestamp } from './formatTime'

export type PdfScreenshotItem = {
  imageDataUrl: string
  seconds: number
  note: string
}

export const PDF_ITEMS_PER_PAGE = 2
const GRID_COLS = 1
const GRID_ROWS = 2
const GAP = 10

const MARGIN = 50
const TITLE_SIZE = 11
const PAGE_NUMBER_SIZE = 9

const HEADER_OFFSET = 22
const FOOTER_RESERVE = 28

const CELL_TIME_SIZE = 9
const CELL_NOTE_SIZE = 8
const CELL_NOTE_LINE = 11
const MAX_NOTE_LINES_IN_CELL = 3
const META_PAD = 6

export type BuildStudyPdfOptions = {
  maxPagesPerFile?: number
}

export type BuildStudyPdfResult = {
  parts: Uint8Array[]
  pagesPerPart: number[]
}

type GridSlot = {
  item: PdfScreenshotItem
  image: PDFImage
} | null

function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const lines: string[] = []
  for (const paragraph of normalized.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word
      const w = font.widthOfTextAtSize(trial, size)
      if (w <= maxWidth || !line) {
        line = trial
      } else {
        lines.push(line)
        line = word
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

function drawFooter(page: PDFPage, font: PDFFont, pageIndex: number, total: number): void {
  const { width } = page.getSize()
  const label = `${pageIndex + 1} / ${total}`
  const tw = font.widthOfTextAtSize(label, PAGE_NUMBER_SIZE)
  page.drawText(label, {
    x: (width - tw) / 2,
    y: MARGIN / 2,
    size: PAGE_NUMBER_SIZE,
    font,
    color: rgb(0.45, 0.45, 0.48),
  })
}

async function embedDataUrlImage(doc: PDFDocument, dataUrl: string): Promise<PDFImage> {
  const bytes = await fetch(dataUrl).then((r) => r.arrayBuffer())
  try {
    return await doc.embedPng(bytes)
  } catch {
    return await doc.embedJpg(bytes)
  }
}

export function totalPdfPagesForCaptureCount(count: number): number {
  if (count <= 0) return 0
  return Math.ceil(count / PDF_ITEMS_PER_PAGE)
}

function chunkItems<T>(items: T[], maxPagesPerFile: number): T[][] {
  const chunkSize = maxPagesPerFile * PDF_ITEMS_PER_PAGE
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

function drawGridPage(
  page: PDFPage,
  slots: GridSlot[],
  meta: { videoId: string },
  pageIndex: number,
  totalPagesInDoc: number,
  bodyFont: PDFFont,
  boldFont: PDFFont,
): void {
  const { width, height } = page.getSize()

  let y = height - MARGIN
  page.drawText(`YouTube study — ${meta.videoId}`, {
    x: MARGIN,
    y,
    size: PAGE_NUMBER_SIZE,
    font: bodyFont,
    color: rgb(0.45, 0.45, 0.48),
  })
  y -= HEADER_OFFSET

  const gridTop = y
  const gridBottom = MARGIN + FOOTER_RESERVE
  const gridHeight = gridTop - gridBottom
  const cellW =
    (width - MARGIN * 2 - Math.max(0, GRID_COLS - 1) * GAP) / GRID_COLS
  const cellH =
    (gridHeight - Math.max(0, GRID_ROWS - 1) * GAP) / GRID_ROWS

  const metaBlockH =
    CELL_TIME_SIZE + 4 + MAX_NOTE_LINES_IN_CELL * CELL_NOTE_LINE + META_PAD

  for (let si = 0; si < PDF_ITEMS_PER_PAGE; si++) {
    const slot = slots[si]
    const col = si % GRID_COLS
    const row = Math.floor(si / GRID_COLS)
    const cellLeft = MARGIN + col * (cellW + GAP)
    const cellTopY = gridTop - row * (cellH + GAP)

    const innerPad = 4
    const imgMaxW = cellW - innerPad * 2
    const imgMaxH = Math.max(40, cellH - metaBlockH - innerPad * 2)

    if (!slot) continue

    const { item, image } = slot
    const scale = Math.min(imgMaxW / image.width, imgMaxH / image.height)
    const imgW = image.width * scale
    const imgH = image.height * scale
    const imgX = cellLeft + (cellW - imgW) / 2
    const imgBottomY = cellTopY - cellH + metaBlockH + innerPad
    page.drawImage(image, { x: imgX, y: imgBottomY, width: imgW, height: imgH })

    let ty = imgBottomY - 6
    const timeLabel = formatTimestamp(item.seconds)
    page.drawText(timeLabel, {
      x: cellLeft + innerPad,
      y: ty - CELL_TIME_SIZE,
      size: CELL_TIME_SIZE,
      font: boldFont,
      color: rgb(0.12, 0.12, 0.14),
    })
    ty -= CELL_TIME_SIZE + 4

    const noteLines = wrapLines(item.note, bodyFont, CELL_NOTE_SIZE, cellW - innerPad * 2)
    const linesToDraw = noteLines.slice(0, MAX_NOTE_LINES_IN_CELL)
    if (linesToDraw.length === 0) {
      page.drawText('—', {
        x: cellLeft + innerPad,
        y: ty - CELL_NOTE_SIZE,
        size: CELL_NOTE_SIZE,
        font: bodyFont,
        color: rgb(0.35, 0.35, 0.38),
      })
    } else {
      for (const line of linesToDraw) {
        page.drawText(line, {
          x: cellLeft + innerPad,
          y: ty - CELL_NOTE_SIZE,
          size: CELL_NOTE_SIZE,
          font: bodyFont,
          color: rgb(0.25, 0.25, 0.28),
        })
        ty -= CELL_NOTE_LINE
      }
    }
  }

  drawFooter(page, bodyFont, pageIndex, totalPagesInDoc)
}

async function buildDocumentForItems(
  items: PdfScreenshotItem[],
  meta: { videoId: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const bodyFont = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)

  if (items.length === 0) {
    const page = doc.addPage()
    page.drawText('No screenshots to export.', {
      x: MARGIN,
      y: page.getSize().height - MARGIN,
      size: TITLE_SIZE,
      font: bodyFont,
      color: rgb(0.2, 0.2, 0.22),
    })
    return doc.save()
  }

  const totalPages = totalPdfPagesForCaptureCount(items.length)

  for (let p = 0; p < totalPages; p++) {
    const page = doc.addPage()
    const start = p * PDF_ITEMS_PER_PAGE
    const slice = items.slice(start, start + PDF_ITEMS_PER_PAGE)

    const slots: GridSlot[] = []
    for (let s = 0; s < PDF_ITEMS_PER_PAGE; s++) {
      if (s < slice.length) {
        const item = slice[s]
        const image = await embedDataUrlImage(doc, item.imageDataUrl)
        slots.push({ item, image })
      } else {
        slots.push(null)
      }
    }

    drawGridPage(page, slots, meta, p, totalPages, bodyFont, boldFont)
  }

  return doc.save()
}

/**
 * Builds one or more PDFs (1×2 grid: 2 captures per page, stacked). If `maxPagesPerFile` is set,
 * splits into multiple documents with at most that many pages each.
 */
export async function buildStudyPdf(
  items: PdfScreenshotItem[],
  meta: { videoId: string },
  options?: BuildStudyPdfOptions,
): Promise<BuildStudyPdfResult> {
  if (items.length === 0) {
    const bytes = await buildDocumentForItems([], meta)
    return { parts: [bytes], pagesPerPart: [1] }
  }

  const maxP = options?.maxPagesPerFile
  if (maxP != null && maxP > 0 && Number.isFinite(maxP)) {
    const chunks = chunkItems(items, Math.floor(maxP))
    const parts: Uint8Array[] = []
    const pagesPerPart: number[] = []
    for (const chunk of chunks) {
      parts.push(await buildDocumentForItems(chunk, meta))
      pagesPerPart.push(totalPdfPagesForCaptureCount(chunk.length))
    }
    return { parts, pagesPerPart }
  }

  const bytes = await buildDocumentForItems(items, meta)
  const pages = totalPdfPagesForCaptureCount(items.length)
  return { parts: [bytes], pagesPerPart: [pages] }
}

export function downloadPdf(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const blob = new Blob([copy], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export type PdfZipEntry = {
  filename: string
  data: Uint8Array
}

/** DEFLATE-compressed ZIP of PDF parts (one browser download). */
export async function downloadPdfZip(
  entries: PdfZipEntry[],
  zipFilename: string,
): Promise<void> {
  const zip = new JSZip()
  for (const { filename, data } of entries) {
    zip.file(filename, data)
  }
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = zipFilename
  a.click()
  URL.revokeObjectURL(url)
}
