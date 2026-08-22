// The watch pass — the one part of December that goes and looks again.
//
// A person writes "keep track of the UF home schedule" and that block gets a
// watch tag (lib/blocks.mjs). This module is what the tag means: on its own
// clock, December re-reads the thing the block names and drops what the page
// actually said back onto the page as an ordinary capture. Nothing else here
// reaches the network — an untagged block, an archived space, and every
// ordinary capture are all outside this door. Milk stays milk.
//
// It is a SEPARATE pass from settle, deliberately:
//   - settle organizes what a person just wrote; watch re-reads what they
//     asked to keep current, whether or not they wrote anything today
//   - the lookup itself runs in this process through December's own
//     search/fetch (lib/web-lookup.mjs), so both engines — and any harness —
//     get the same guards, the same official-source rule, and the same
//     refusal to invent. No engine is called from here at all.
//   - what comes back is filed by the ordinary settle pass, because filing
//     is judgment and judgment already has a home.
//
// A refresh never manufactures a fact: the capture carries the page's own
// words and the url they came from. When a lookup fails it stays failed,
// honestly, and is retried on a widening backoff instead of being papered
// over with something plausible.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { watchQuery } from './blocks.mjs'
import { FALLBACK, fetchPage as realFetchPage, searchWeb as realSearchWeb } from './web-lookup.mjs'

// Conservative on purpose. A watch is a standing interest, not a feed: six
// hours is far more current than a person re-checking by hand, and far less
// traffic than anyone would notice.
export const REFRESH_MS = 6 * 3600 * 1000
export const RETRY_BASE_MS = 15 * 60 * 1000
export const RETRY_MAX_MS = 24 * 3600 * 1000
export const MAX_PER_PASS = 2 // one pass, at most two lookups, always in turn
export const START_DELAY_MS = 20_000 // after boot, behind the first settle
export const TICK_MS = 30 * 60 * 1000
export const NOTICE_AFTER = 3 // failures before the page is told, once
const EXCERPT = 400
const RUNS_FILE = 'watch.json'

const iso = (ms) => new Date(ms).toISOString()

/** Every watched block on an open space. This list IS the network gate:
    nothing that is not on it is ever looked up. */
export function watchedBlocks(page) {
  const out = []
  for (const space of page?.spaces || []) {
    if (space?.finished) continue // archived: the watch stops with the space
    for (const block of space.blocks || []) {
      if (!block?.watch) continue // untagged: never looked up
      const query = watchQuery(block)
      if (!query) continue // nothing to ask; a blank query is not a lookup
      out.push({ blockId: block.id, spaceId: space.id, space: space.name || '', title: block.title || '', query })
    }
  }
  return out
}

/** The earliest a watch may go again. A good refresh waits out the interval;
    a failed one waits out a doubling backoff, capped so it never gives up. */
export function dueAt(run) {
  const since = Date.parse(run?.at || '')
  if (!Number.isFinite(since)) return 0
  if (run.ok) return since + REFRESH_MS
  const failures = Math.max(1, Number(run.failures) || 1)
  return since + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1))
}

/** Which watches may run right now, in page order. */
export function dueWatches(page, runs = {}, now = Date.now()) {
  return watchedBlocks(page).filter((w) => dueAt(runs[w.blockId]) <= now)
}

// A results page is a list of guesses. The organization's own site beats an
// aggregator, and a snippet is never the answer — the page behind it is.
const AGGREGATOR = /(^|\.)(reddit\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|pinterest\.com|youtube\.com|quora\.com|medium\.com|tripadvisor\.com|yelp\.com|pinterest\.[a-z.]+)$/i
const OFFICIAL_TLD = /\.(gov|edu|mil)$/i

/** The most official source in a result set, or null when none can be read. */
export function officialPick(results = [], query = '') {
  const words = String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || []
  let best = null
  for (const [i, result] of results.entries()) {
    let host
    try {
      host = new URL(result?.url || '').hostname.toLowerCase()
    } catch {
      continue
    }
    let score = -i * 0.1 // the search engine's own order breaks ties
    if (AGGREGATOR.test(host)) score -= 5
    if (OFFICIAL_TLD.test(host)) score += 2
    if (words.some((word) => host.replace(/[^a-z0-9]/g, '').includes(word))) score += 3
    if (!best || score > best.score) best = { score, result }
  }
  return best?.result || null
}

/** What a refresh puts back on the page: the person's own question, the
    source it was answered from, and the page's own words. Never a summary,
    never a conclusion — filing that is the settle pass's job. */
export function watchCapture({ query, title, read }) {
  const excerpt = String(read?.text || '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT)
  const heading = [
    `[watch: ${query}]`,
    title && title.toLowerCase() !== query.toLowerCase() ? `on "${title}"` : '',
    read?.title ? `— ${String(read.title).slice(0, 120)}` : '',
    `— ${read?.url || ''}`,
  ].filter(Boolean).join(' ')
  return `${heading}\n${excerpt}`.slice(0, 4000)
}

/** The honest end of a lookup that keeps failing: say so once, name what to
    check, and let the person decide. Nothing is invented to fill the gap. */
export function watchFailureNotice({ query, error }) {
  return `[watch: ${query}] the last ${NOTICE_AFTER} refreshes failed (${String(error).slice(0, 160)}); ${FALLBACK}`
}

const fingerprintOf = (url, text) =>
  createHash('sha256').update(`${url}\n${String(text || '').slice(0, 4000)}`, 'utf8').digest('base64url').slice(0, 22)

// ------------------------------------------------------------ run records
// How a refresh went is bookkeeping, not page content: it lives beside the
// page in its own small file, so a watch never rewrites a space's updatedAt
// or spends the person's undo just to remember that it looked.

function fileStore(dataDir) {
  const path = join(dataDir, RUNS_FILE)
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        return parsed?.runs && typeof parsed.runs === 'object' ? parsed.runs : {}
      } catch {
        return {} // no file yet, or an unreadable one: every watch is simply due
      }
    },
    async write(runs) {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.writing`
      await writeFile(tmp, JSON.stringify({ runs }, null, 2))
      await rename(tmp, path)
    },
  }
}

/** Real page and real lookup, resolved lazily so the pass can be exercised
    without loading the live page at all. */
async function resolveDeps(deps = {}) {
  const needsCore = !deps.page || !deps.addCapture || (!deps.store && !deps.dataDir)
  const core = needsCore ? await import('./core.mjs') : null
  return {
    page: deps.page || (() => core.project()),
    addCapture: deps.addCapture || ((text, hint) => core.addCapture(text, hint)),
    searchWeb: deps.searchWeb || realSearchWeb,
    fetchPage: deps.fetchPage || realFetchPage,
    store: deps.store || fileStore(deps.dataDir || core.DATA_DIR),
    onCaptured: deps.onCaptured,
  }
}

const s = { running: false, lastRunAt: null, lastError: null, watching: 0 }

export const status = () => ({ ...s })

/** One bounded pass: at most `max` due watches, one lookup at a time. */
export async function runWatchPass({ now = Date.now(), max = MAX_PER_PASS, ...deps } = {}) {
  if (s.running) return { skipped: true, due: 0, captured: 0, failed: 0 }
  s.running = true
  try {
    const d = await resolveDeps(deps)
    const page = await d.page()
    const watched = watchedBlocks(page)
    s.watching = watched.length
    const runs = await d.store.read()
    // A block that was untagged or archived stops being remembered at all,
    // so re-tagging it later is a fresh start rather than an old backoff.
    const live = new Set(watched.map((w) => w.blockId))
    let pruned = false
    for (const id of Object.keys(runs)) {
      if (!live.has(id)) {
        delete runs[id]
        pruned = true
      }
    }
    const due = watched.filter((w) => dueAt(runs[w.blockId]) <= now).slice(0, Math.max(0, max))
    if (!due.length) {
      if (pruned) await d.store.write(runs)
      return { skipped: false, due: 0, captured: 0, failed: 0 }
    }

    let captured = 0
    let failed = 0
    let lastError = null
    for (const w of due) {
      const prior = runs[w.blockId] || {}
      try {
        const found = await d.searchWeb({ query: w.query, limit: 5 })
        const pick = officialPick(found?.results || [], w.query)
        if (!pick) throw new Error(`nothing came back for "${w.query}" — ${FALLBACK}`)
        const read = await d.fetchPage({ url: pick.url })
        const fingerprint = fingerprintOf(read.url, read.text)
        // The same page saying the same thing is not news. Re-filing it every
        // few hours would bury the person under their own watch.
        if (fingerprint !== prior.fingerprint) {
          await d.addCapture(watchCapture({ query: w.query, title: w.title, read }), w.space)
          captured++
        }
        runs[w.blockId] = { at: iso(now), ok: true, url: read.url, fingerprint, failures: 0 }
      } catch (err) {
        const error = String(err?.message || err).slice(0, 200)
        const failures = (Number(prior.failures) || 0) + 1
        let notified = prior.notified === true
        if (failures >= NOTICE_AFTER && !notified) {
          try {
            await d.addCapture(watchFailureNotice({ query: w.query, error }), w.space)
            captured++
            notified = true
          } catch {
            // telling the page failed too; the next pass will try again
          }
        }
        runs[w.blockId] = { at: iso(now), ok: false, failures, error, notified, fingerprint: prior.fingerprint || '' }
        failed++
        lastError = error
      }
    }
    await d.store.write(runs)
    s.lastRunAt = iso(now)
    s.lastError = lastError
    if (captured) await d.onCaptured?.()
    return { skipped: false, due: due.length, captured, failed }
  } finally {
    s.running = false
  }
}

/** Wake the watch shortly after the app opens, then on a slow tick. Returns
    the stop, because a server that will not shut down is its own bug. */
export function startWatch({ startDelayMs = START_DELAY_MS, tickMs = TICK_MS, ...deps } = {}) {
  const kick = () => {
    void runWatchPass(deps).catch((err) => console.log('watch pass failed:', String(err?.message || err).slice(0, 200)))
  }
  const first = setTimeout(kick, startDelayMs)
  const tick = setInterval(kick, tickMs)
  return () => {
    clearTimeout(first)
    clearInterval(tick)
  }
}
