// Review build: isolated synthetic data, real December server and mutation code.
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const live = !process.argv.includes('--simulate')
process.env.PORT ||= '3007'
process.env.DECEMBER_DATA_DIR = join(root, 'data', live ? 'jev-live-preview' : 'jev-preview')
process.env.DECEMBER_JEV_MODE = process.argv.includes('--shadow') ? 'shadow' : 'fast'
process.env.DECEMBER_JEV_FIXTURE = live ? '0' : '1'
if (live) {
  process.env.TYPESAFE_API_KEY_FILE ||= join(root, 'data', 'credentials', 'typesafe.key')
  const { jevConfig } = await import('../lib/jev.mjs')
  if (!jevConfig().ready) throw new Error('Live preview requires TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE. No key is configured.')
}
await mkdir(process.env.DECEMBER_DATA_DIR, { recursive: true })
if (!live) await writeFile(join(process.env.DECEMBER_DATA_DIR, '.jev-synthetic-preview'), 'Synthetic review data only. Model responses are simulated.\n')
let seeded = false
try { await access(join(process.env.DECEMBER_DATA_DIR, 'state.json')); seeded = true } catch {}
if (!seeded) {
  const core = await import('../lib/core.mjs')
  for (const [name, items] of [
    ['Groceries', ['eggs', 'bread']], ['Packing', ['passport', 'sunscreen']],
    ['Books', ['Dune']],
  ]) {
    const space = await core.createSpace(name)
    await core.createBlock(space.id, { type: 'list', title: name, items })
  }
}
console.log(live ? 'Jev LIVE API · synthetic December page' : 'Jev SIMULATED provider · real December save/undo · synthetic page')
await import('../server.mjs')
