// December's house manners — the etiquette every visiting assistant is held
// to, served live rather than copied.
//
// `skills/december/SKILL.md` is the one source. The skill publisher copies it
// beside each skill-aware host; this module reads the same file so the MCP
// adapter can hand it to every client at connect time, including the ones that
// have no notion of a skill. One text, two carriers, no drift.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// Electron runs the unpacked server beside unpacked public assets; the
// packaged mirror is the fallback when root-level skills were not copied.
const SOURCES = [
  join(ROOT, 'skills', 'december', 'SKILL.md'),
  join(ROOT, 'public', 'skills', 'december', 'SKILL.md'),
]

/** Strip the YAML frontmatter; an assistant needs the prose, not the manifest. */
export function skillBody(text) {
  return String(text || '').replace(/^---\s*[\s\S]*?^---\s*$/m, '').trim()
}

/** The version recorded in the frontmatter, matching the publisher's reading. */
export function skillVersion(text) {
  const match = /^---\s*[\s\S]*?^version:\s*["']?([^\s"']+)/m.exec(String(text || ''))
  return match?.[1] || '0.0.0'
}

let cache = null

/**
 * The manners text and its version. Missing manners are not an error: a client
 * that cannot read them still gets the full tool surface, which carries its own
 * per-tool guidance.
 */
export async function manners() {
  if (cache) return cache
  for (const source of SOURCES) {
    try {
      const text = await readFile(source, 'utf8')
      cache = { manners: skillBody(text), version: skillVersion(text) }
      return cache
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  cache = { manners: '', version: '0.0.0' }
  return cache
}

/** Test seam: forget the cached read. */
export function resetManners() {
  cache = null
}
