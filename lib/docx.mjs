// Minimal .docx text extraction — zero dependencies, like everything here.
// A .docx is a zip; the words live in word/document.xml. This reads the
// zip's central directory, inflates that one entry, and flattens the XML
// to plain text. Good enough for the settle agent to read a dropped doc;
// not a converter (no tables-as-tables, no images).

import { inflateRawSync } from 'node:zlib'

/** Find a named entry via the end-of-central-directory record. */
function zipEntry(buf, wanted) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip')
  let off = buf.readUInt32LE(eocd + 16)
  const count = buf.readUInt16LE(eocd + 10)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    if (name === wanted) {
      // trust the local header's own name/extra lengths for the data offset
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const start = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(start, start + compSize)
      if (method === 8) return inflateRawSync(raw)
      if (method === 0) return raw
      throw new Error(`unsupported zip compression: ${method}`)
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`${wanted} not found in archive`)
}

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")

/** Plain text of a .docx buffer: one line per paragraph. Throws if it
    isn't readable — callers fall back to filing the doc unread. */
export function docxText(buf) {
  const xml = zipEntry(buf, 'word/document.xml').toString('utf8')
  const paragraphs = xml.split(/<\/w:p>/)
  const lines = []
  for (const p of paragraphs) {
    const runs = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeEntities(m[1]))
    const line = runs.join('').replace(/\s+/g, ' ').trim()
    if (line) lines.push(line)
  }
  const text = lines.join('\n').trim()
  if (!text) throw new Error('no text found in document')
  return text
}
