#!/usr/bin/env node
// Import a local result of explicit retrieval. No fetching and no model call.
// node scripts/cache-preview.mjs DATA_DIR INPUT.json
// Image input: {kind:"image",source:"https://…",imagePath:"./photo.jpg",alt:"…",credit:"…"}
// Weather input: the normalized weather fields in public/js/preview-model.js.
import { readFile, writeFile, mkdir, rename, rm, open } from 'node:fs/promises'
import { dirname, resolve, join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { normalizePreview } from '../public/js/preview-model.js'
import { createPreviewStore } from '../lib/previews.mjs'

const [dataArg, inputArg] = process.argv.slice(2)
if (!dataArg || !inputArg) throw new Error('Usage: node scripts/cache-preview.mjs DATA_DIR INPUT.json')
const root = join(resolve(dataArg), 'previews')
const inputPath = resolve(inputArg)
const input = await readFile(inputPath, 'utf8')
if (Buffer.byteLength(input) > 32_000) throw new Error('preview input too large')
const raw = JSON.parse(input)
await mkdir(join(root, 'assets'), { recursive: true })
// Exclusive lock prevents two importers from overwriting one another's entries.
const lock = await open(join(root, '.import-lock'), 'wx')
let tmp
try {
  if (raw.kind === 'image') {
    if (typeof raw.imagePath !== 'string') throw new Error('imagePath must name a local image')
    const file = resolve(dirname(inputPath), raw.imagePath)
    const ext = extname(file).toLowerCase().replace('.jpeg','.jpg')
    if (!['.jpg','.png','.webp'].includes(ext)) throw new Error('use a JPEG, PNG, or WebP image')
    const image = await open(file, 'r')
    let bytes
    try {
      const stat = await image.stat()
      if (!stat.isFile() || stat.size > 5_000_000) throw new Error('image must be a file under 5 MB')
      bytes = await image.readFile()
    } finally { await image.close() }
    raw.asset = createHash('sha256').update(bytes).digest('hex') + ext
    await writeFile(join(root,'assets',raw.asset), bytes)
    if (!createPreviewStore(resolve(dataArg)).asset(raw.asset)) throw new Error('image bytes do not match its format')
  }
  const preview = normalizePreview(raw)
  if (!preview) throw new Error('invalid preview data')
  let rows = []
  try { rows = JSON.parse(await readFile(join(root,'index.json'),'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!Array.isArray(rows)) throw new Error('invalid existing preview index')
  const next = [...rows.filter(p => p.source !== preview.source), preview]
  const json = JSON.stringify(next, null, 2)
  if (next.length > 200 || Buffer.byteLength(json) > 256_000) throw new Error('preview cache full; remove an unused entry first')
  tmp = join(root, `index-${process.pid}.tmp`)
  await writeFile(tmp,json)
  await rename(tmp,join(root,'index.json'))
  console.log(`Cached ${preview.kind} preview for ${preview.source}`)
} finally {
  if (tmp) await rm(tmp,{force:true})
  await lock.close()
  await rm(join(root,'.import-lock'),{force:true})
}
