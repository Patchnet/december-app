// A bounded, local-only cache beside the page. It decorates HTTP page views,
// never durable blocks, agent tools, or the agent's condensed view.
// A retrieval/import adapter can populate it after explicitly requested work.
import { readFileSync, statSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { normalizePreview, sourceURL, ASSET_NAME } from '../public/js/preview-model.js'

export function createPreviewStore(dataDir) {
  const root = join(dataDir, 'previews')
  let checked = 0, mtime = '', index = new Map(), revision = 'none'
  function load() {
    if (Date.now() - checked < 1000) return
    checked = Date.now()
    try {
      const path = join(root, 'index.json'), stat = statSync(path)
      if (!stat.isFile() || stat.size > 256_000) throw new Error('preview index too large')
      const stamp = `${stat.mtimeMs}:${stat.size}`
      if (mtime === stamp) return
      const rows = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(rows) || rows.length > 200) throw new Error('invalid preview index')
      const next = new Map()
      for (const row of rows) {
        const p = normalizePreview(row)
        if (p) next.set(p.source, p)
      }
      index = next
      revision = createHash('sha256').update(JSON.stringify([...index])).digest('hex').slice(0, 16)
      mtime = stamp
    } catch { index = new Map(); revision = 'none'; mtime = '' }
  }
  function lookup(block) {
    if (block.type !== 'note') return null
    const urls = String(block.text || '').match(/https?:\/\/[^\s<>"']+/g) || []
    for (const url of urls.slice(0, 8)) {
      const hit = index.get(sourceURL(url.replace(/[),.;!?]+$/, '')))
      if (hit) return hit
    }
    return null
  }
  // Expiry changes presentation even if the underlying note has not changed.
  const viewRevision = () => revision + ':' + [...index.values()].map(p => p.kind === 'weather' && (!p.expiresAt || Date.parse(p.expiresAt) <= Date.now()) ? '1' : '0').join('')
  return {
    revision() { load(); return viewRevision() },
    decorate(body) {
      if (!Array.isArray(body?.spaces) || !Array.isArray(body?.captures)) return body
      load()
      return { ...body, spaces: body.spaces.map(s => {
        // At most one preview per space; mixed spaces keep all their blocks.
        let used = false
        const blocks = s.blocks.map(b => {
          const preview = used ? null : lookup(b)
          if (!preview) return b
          used = true
          return { ...b, preview }
        })
        return { ...s, blocks, previewKey: used ? viewRevision() : '' }
      }) }
    },
    asset(name) {
      if (!ASSET_NAME.test(name)) return null
      try {
        const base = realpathSync(join(root, 'assets'))
        const path = realpathSync(join(base, name))
        if (!path.startsWith(base + sep)) return null
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > 5_000_000) return null
        const bytes = readFileSync(path)
        const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        if (!(name.endsWith('.jpg') && jpg || name.endsWith('.png') && png || name.endsWith('.webp') && webp)) return null
        if (createHash('sha256').update(bytes).digest('hex') !== name.split('.')[0]) return null
        return { bytes, type: jpg ? 'image/jpeg' : png ? 'image/png' : 'image/webp' }
      } catch { return null }
    },
  }
}
