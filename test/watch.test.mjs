// The watch pass — what a tag on a block does, and what it must never do.
// Every test here injects its own page, lookup, and run store: no live page
// state is touched and no socket is ever opened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBlock, updateBlock, verbPatch, verbTools, createBlockFields, watchQuery } from '../lib/blocks.mjs'
import {
  MAX_PER_PASS,
  NOTICE_AFTER,
  REFRESH_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  dueAt,
  dueWatches,
  officialPick,
  runWatchPass,
  startWatch,
  watchCapture,
  watchedBlocks,
} from '../lib/watch.mjs'

const HOUR = 3600 * 1000
const T0 = Date.parse('2026-08-22T12:00:00.000Z')

const space = (blocks, extra = {}) => ({ id: 'sp1', name: 'Gators', finished: false, blocks, ...extra })
const pageOf = (...spaces) => ({ spaces })

const watchedNote = (text = 'UF football home schedule', extra = {}) => ({
  id: 'b1', type: 'note', title: '', text, entities: [], watch: { since: '2026-08-01T00:00:00.000Z' }, ...extra,
})

const clone = (value) => JSON.parse(JSON.stringify(value))

function memoryStore(initial = {}) {
  let runs = clone(initial)
  return {
    current: () => clone(runs),
    async read() {
      return clone(runs)
    },
    async write(next) {
      runs = clone(next)
    },
  }
}

/** A lookup that records everything it was asked, so a test can prove a
    query was never made at all. */
function fakeLookup({ results, text = 'Sept 6 vs Miami, 3:30 pm ET.', title = '2026 Schedule', fail } = {}) {
  const searches = []
  const fetches = []
  return {
    searches,
    fetches,
    searchWeb: async ({ query, limit }) => {
      searches.push({ query, limit })
      if (fail === 'search') throw new Error('could not reach example.com — file a look-up task')
      return {
        query,
        results: results || [
          { title: 'Gators tickets on Reddit', url: 'https://reddit.com/r/gators/thread', snippet: 'someone said' },
          { title: 'Florida Gators football schedule', url: 'https://floridagators.com/schedule', snippet: 'official' },
        ],
        note: 'snippets are not facts',
      }
    },
    fetchPage: async ({ url }) => {
      fetches.push(url)
      if (fail === 'fetch') throw new Error('example.com answered 503 — file a look-up task')
      return { url, title, text, truncated: false, fetchedAt: '2026-08-22T12:00:00.000Z', note: 'file only what this text states' }
    },
  }
}

function captureSink() {
  const captures = []
  return { captures, addCapture: async (text, hint) => captures.push({ text, hint }) }
}

// ------------------------------------------------------------ the tag

test('a watch is a tag on an ordinary block, set at creation or by its own verb', () => {
  const born = makeBlock({ type: 'note', title: 'Schedule', text: 'UF home schedule', watch: true })
  assert.equal(born.type, 'note', 'watching adds no seventh block type')
  assert.ok(born.watch?.since, 'the tag records when the watch began')

  const plain = makeBlock({ type: 'note', title: 'Schedule', text: 'UF home schedule' })
  assert.equal(plain.watch, undefined, 'nothing is watched unless it was asked for')

  updateBlock(plain, { note_text: 'UF home schedule', set_watch: true })
  assert.ok(plain.watch?.since)
  const since = plain.watch.since
  updateBlock(plain, { set_watch: true })
  assert.equal(plain.watch.since, since, 're-tagging does not restart the watch')

  updateBlock(plain, { set_watch: false })
  assert.equal(Object.hasOwn(plain, 'watch'), false, 'untagging leaves nothing behind')
})

test('every block verb can set and clear the tag, and says nothing when it is not mentioned', () => {
  for (const tool of verbTools()) {
    assert.equal(tool.inputSchema.properties.watch?.type, 'boolean', `${tool.name} must be able to tag its block`)
  }
  assert.equal(createBlockFields().watch?.type, 'boolean', 'a block can be born watched')

  assert.equal(verbPatch('december_write_note', { blockId: 'b5', text: 'hi', watch: true }).patch.set_watch, true)
  assert.equal(verbPatch('december_set_reminder', { blockId: 'b6', watch: false }).patch.set_watch, false)
  assert.equal(verbPatch('december_mark_day', { blockId: 'b4', watch: 'yes' }).patch.set_watch, false, 'only true tags')
  assert.equal(
    Object.hasOwn(verbPatch('december_add_or_check', { blockId: 'b1', add: ['milk'] }).patch, 'set_watch'),
    false,
    'an ordinary verb call never touches the tag'
  )
})

test('the block\'s own words are the query', () => {
  assert.equal(watchQuery(watchedNote('UF football home schedule\nchecked in August')), 'UF football home schedule')
  assert.equal(watchQuery({ type: 'reminder', text: 'Passport renewal backlog', title: 'Passport' }), 'Passport renewal backlog')
  assert.equal(watchQuery({ type: 'tracker', title: 'Gas prices', current: 1 }), 'Gas prices')
  assert.equal(watchQuery({ type: 'note', text: '   ', title: '' }), '')
})

// ------------------------------------------------------- who is eligible

test('only tagged blocks on open spaces are watched', () => {
  const page = pageOf(
    space([
      watchedNote(),
      { id: 'b2', type: 'list', title: 'Groceries', items: [{ id: 'i1', text: 'milk', done: false }] },
      { id: 'b3', type: 'note', title: '', text: '  ', watch: { since: '2026-08-01T00:00:00.000Z' } },
    ])
  )
  const watched = watchedBlocks(page)
  assert.deepEqual(watched.map((w) => w.blockId), ['b1'])
  assert.equal(watched[0].query, 'UF football home schedule')
  assert.equal(watched[0].space, 'Gators')
})

test('archiving the space, or untagging the block, stops the watch', () => {
  const block = watchedNote()
  assert.equal(watchedBlocks(pageOf(space([block]))).length, 1)
  assert.equal(watchedBlocks(pageOf(space([block], { finished: true }))).length, 0, 'an archived space is not watched')

  updateBlock(block, { set_watch: false })
  assert.equal(watchedBlocks(pageOf(space([block]))).length, 0, 'an untagged block is not watched')
})

test('a refresh waits out its interval, and a failure widens its backoff without giving up', () => {
  assert.equal(dueAt(undefined), 0, 'a watch that never ran is due now')
  assert.equal(dueAt({ at: 'not a date', ok: true }), 0)
  assert.equal(dueAt({ at: new Date(T0).toISOString(), ok: true }), T0 + REFRESH_MS)
  assert.equal(dueAt({ at: new Date(T0).toISOString(), ok: false, failures: 1 }), T0 + RETRY_BASE_MS)
  assert.equal(dueAt({ at: new Date(T0).toISOString(), ok: false, failures: 3 }), T0 + RETRY_BASE_MS * 4)
  assert.equal(dueAt({ at: new Date(T0).toISOString(), ok: false, failures: 40 }), T0 + RETRY_MAX_MS, 'the backoff is capped, so it stays retryable')

  const page = pageOf(space([watchedNote()]))
  const fresh = { b1: { at: new Date(T0 - HOUR).toISOString(), ok: true } }
  assert.equal(dueWatches(page, fresh, T0).length, 0)
  assert.equal(dueWatches(page, fresh, T0 + REFRESH_MS).length, 1)
})

test('the most official source wins over an aggregator', () => {
  assert.equal(
    officialPick(
      [
        { url: 'https://reddit.com/r/gators/thread' },
        { url: 'https://floridagators.com/schedule' },
        { url: 'https://espn.com/college-football' },
      ],
      'florida gators schedule'
    ).url,
    'https://floridagators.com/schedule'
  )
  assert.equal(officialPick([{ url: 'https://news.example/x' }, { url: 'https://dmv.ca.gov/fees' }], 'ca dmv fees').url, 'https://dmv.ca.gov/fees')
  assert.equal(officialPick([{ url: 'not a url' }], 'anything'), null)
  assert.equal(officialPick([], 'anything'), null)
})

// -------------------------------------------------------------- the pass

test('a due watch reads the official source and files the page\'s own words', async () => {
  const lookup = fakeLookup()
  const sink = captureSink()
  const store = memoryStore()
  let settled = 0

  const result = await runWatchPass({
    now: T0,
    page: () => pageOf(space([watchedNote()])),
    store,
    addCapture: sink.addCapture,
    searchWeb: lookup.searchWeb,
    fetchPage: lookup.fetchPage,
    onCaptured: () => settled++,
  })

  assert.deepEqual(result, { skipped: false, due: 1, captured: 1, failed: 0 })
  assert.deepEqual(lookup.searches, [{ query: 'UF football home schedule', limit: 5 }])
  assert.deepEqual(lookup.fetches, ['https://floridagators.com/schedule'], 'the aggregator is not what gets read')
  assert.equal(settled, 1, 'what came back settles like anything else the page receives')

  const [capture] = sink.captures
  assert.equal(sink.captures.length, 1)
  assert.match(capture.text, /^\[watch: UF football home schedule\]/)
  assert.match(capture.text, /https:\/\/floridagators\.com\/schedule/, 'the source travels with the words')
  assert.ok(capture.text.includes('Sept 6 vs Miami, 3:30 pm ET.'), 'the excerpt is the page\'s own text')
  assert.equal(capture.hint, 'Gators', 'it lands beside the block it came from')

  const run = store.current().b1
  assert.equal(run.ok, true)
  assert.equal(run.failures, 0)
  assert.equal(run.at, new Date(T0).toISOString())
  assert.ok(run.fingerprint)
})

test('nothing untagged ever reaches the network', async () => {
  const lookup = fakeLookup()
  const sink = captureSink()
  const quiet = await runWatchPass({
    now: T0,
    page: () => pageOf(space([{ id: 'b2', type: 'note', title: '', text: 'milk' }])),
    store: memoryStore(),
    addCapture: sink.addCapture,
    searchWeb: lookup.searchWeb,
    fetchPage: lookup.fetchPage,
  })
  assert.deepEqual(quiet, { skipped: false, due: 0, captured: 0, failed: 0 })
  assert.deepEqual(lookup.searches, [], 'milk stays milk')
  assert.deepEqual(lookup.fetches, [])
  assert.deepEqual(sink.captures, [])

  // and an untagged neighbour stays out of it even when something else is watched
  const mixed = fakeLookup()
  await runWatchPass({
    now: T0,
    page: () => pageOf(space([{ id: 'b2', type: 'note', title: '', text: 'milk' }, watchedNote()])),
    store: memoryStore(),
    addCapture: captureSink().addCapture,
    searchWeb: mixed.searchWeb,
    fetchPage: mixed.fetchPage,
  })
  assert.deepEqual(mixed.searches.map((s) => s.query), ['UF football home schedule'])
})

test('an archived space is not refreshed, and its run record is forgotten', async () => {
  const lookup = fakeLookup()
  const store = memoryStore({ b1: { at: new Date(T0 - 10 * HOUR).toISOString(), ok: true, failures: 0, fingerprint: 'old' } })
  const result = await runWatchPass({
    now: T0,
    page: () => pageOf(space([watchedNote()], { finished: true })),
    store,
    addCapture: captureSink().addCapture,
    searchWeb: lookup.searchWeb,
    fetchPage: lookup.fetchPage,
  })
  assert.deepEqual(result, { skipped: false, due: 0, captured: 0, failed: 0 })
  assert.deepEqual(lookup.searches, [])
  assert.deepEqual(store.current(), {}, 're-tagging later starts clean, not mid-backoff')
})

test('a refresh does not repeat itself: not before it is due, and never twice for the same page', async () => {
  const page = () => pageOf(space([watchedNote()]))
  const lookup = fakeLookup()
  const sink = captureSink()
  const store = memoryStore()
  const deps = { page, store, addCapture: sink.addCapture, searchWeb: lookup.searchWeb, fetchPage: lookup.fetchPage }

  await runWatchPass({ now: T0, ...deps })
  const again = await runWatchPass({ now: T0 + HOUR, ...deps })
  assert.equal(again.due, 0, 'a second app open an hour later does not look again')
  assert.equal(lookup.searches.length, 1)

  const later = await runWatchPass({ now: T0 + REFRESH_MS + 1, ...deps })
  assert.equal(later.due, 1)
  assert.equal(later.captured, 0, 'the same page saying the same thing is not news')
  assert.equal(sink.captures.length, 1)

  const changed = fakeLookup({ text: 'Sept 6 vs Miami moved to 7:00 pm ET.' })
  const news = await runWatchPass({ ...deps, now: T0 + 2 * REFRESH_MS + 2, searchWeb: changed.searchWeb, fetchPage: changed.fetchPage })
  assert.equal(news.captured, 1, 'a page that changed is news')
  assert.ok(sink.captures[1].text.includes('moved to 7:00 pm ET.'))
})

test('one pass stays bounded no matter how many watches are due', async () => {
  const lookup = fakeLookup()
  const blocks = ['a', 'b', 'c', 'd'].map((id) => watchedNote(`query ${id}`, { id }))
  const result = await runWatchPass({
    now: T0,
    page: () => pageOf(space(blocks)),
    store: memoryStore(),
    addCapture: captureSink().addCapture,
    searchWeb: lookup.searchWeb,
    fetchPage: lookup.fetchPage,
  })
  assert.equal(result.due, MAX_PER_PASS)
  assert.equal(lookup.searches.length, MAX_PER_PASS)
})

// ------------------------------------------------------ failing honestly

test('a failed lookup files nothing, stays retryable, and never invents an answer', async () => {
  const lookup = fakeLookup({ fail: 'fetch' })
  const sink = captureSink()
  const store = memoryStore()
  const deps = {
    page: () => pageOf(space([watchedNote()])),
    store,
    addCapture: sink.addCapture,
    searchWeb: lookup.searchWeb,
    fetchPage: lookup.fetchPage,
  }

  const first = await runWatchPass({ now: T0, ...deps })
  assert.deepEqual(first, { skipped: false, due: 1, captured: 0, failed: 1 })
  assert.deepEqual(sink.captures, [], 'a gap is never filled with something plausible')
  assert.equal(store.current().b1.failures, 1)
  assert.match(store.current().b1.error, /503/)
  assert.equal(dueAt(store.current().b1), T0 + RETRY_BASE_MS, 'it will be tried again')

  // too soon: the backoff holds
  assert.equal((await runWatchPass({ now: T0 + 60_000, ...deps })).due, 0)

  await runWatchPass({ now: T0 + RETRY_BASE_MS, ...deps })
  assert.equal(store.current().b1.failures, 2)
  assert.deepEqual(sink.captures, [])

  // the third failure is worth telling the person about, once
  await runWatchPass({ now: T0 + 10 * HOUR, ...deps })
  assert.equal(store.current().b1.failures, NOTICE_AFTER)
  assert.equal(sink.captures.length, 1)
  assert.match(sink.captures[0].text, /\[watch: UF football home schedule\] the last 3 refreshes failed/)
  assert.match(sink.captures[0].text, /never answer from memory/)
  assert.ok(!/Sept 6/.test(sink.captures[0].text), 'the notice states no fact of its own')

  await runWatchPass({ now: T0 + 40 * HOUR, ...deps })
  assert.equal(store.current().b1.failures, 4)
  assert.equal(sink.captures.length, 1, 'the page is told once, not every pass')

  // and a later success clears the failure without losing the watch
  const healthy = fakeLookup()
  await runWatchPass({ ...deps, now: T0 + 80 * HOUR, searchWeb: healthy.searchWeb, fetchPage: healthy.fetchPage })
  assert.equal(store.current().b1.ok, true)
  assert.equal(store.current().b1.failures, 0)
  assert.equal(sink.captures.length, 2)
})

test('a search that comes back empty is a failure, not a guess', async () => {
  const lookup = fakeLookup({ results: [] })
  const sink = captureSink()
  const store = memoryStore()
  const result = await runWatchPass({
    now: T0,
    page: () => pageOf(space([watchedNote()])),
    store,
    addCapture: sink.addCapture,
    searchWeb: lookup.searchWeb,
    fetchPage: lookup.fetchPage,
  })
  assert.equal(result.failed, 1)
  assert.deepEqual(lookup.fetches, [])
  assert.deepEqual(sink.captures, [])
  assert.match(store.current().b1.error, /nothing came back/)
})

test('the capture carries the source and only the page\'s own words', () => {
  const text = watchCapture({
    query: 'UF football home schedule',
    title: 'Schedule',
    read: { url: 'https://floridagators.com/schedule', title: '2026 Schedule', text: 'Sept 6 vs Miami\n3:30 pm ET' },
  })
  assert.match(text, /^\[watch: UF football home schedule\] on "Schedule" — 2026 Schedule — https:\/\/floridagators\.com\/schedule\n/)
  assert.ok(text.endsWith('Sept 6 vs Miami 3:30 pm ET'))
  assert.ok(text.length <= 4000)
})

// ---------------------------------------------------------- run metadata

test('run records survive a restart, so a reopened app does not look again', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'december-watch-'))
  const lookup = fakeLookup()
  const deps = {
    page: () => pageOf(space([watchedNote()])),
    dataDir: dir,
    addCapture: async () => {},
    searchWeb: lookup.searchWeb,
    fetchPage: lookup.fetchPage,
  }
  // The default store is a file beside the page, never the page itself.
  await runWatchPass({ now: T0, ...deps })
  const saved = JSON.parse(await readFile(join(dir, 'watch.json'), 'utf8'))
  assert.equal(saved.runs.b1.ok, true)

  const reopened = await runWatchPass({ now: T0 + HOUR, ...deps })
  assert.equal(reopened.due, 0)
  assert.equal(lookup.searches.length, 1)
  t.diagnostic(`watch records at ${join(dir, 'watch.json')}`)
})

test('the watch wakes with the app and stops with it', async () => {
  const lookup = fakeLookup()
  const store = memoryStore()
  let passes = 0
  const stop = startWatch({
    startDelayMs: 5,
    tickMs: 3600 * 1000,
    page: () => {
      passes++
      return pageOf(space([watchedNote()]))
    },
    store,
    addCapture: async () => {},
    searchWeb: lookup.searchWeb,
    fetchPage: lookup.fetchPage,
  })
  for (let i = 0; i < 100 && !store.current().b1; i++) await new Promise((r) => setTimeout(r, 10))
  stop()
  assert.equal(passes, 1, 'opening the app looks once')
  assert.equal(store.current().b1?.ok, true)

  const after = passes
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(passes, after, 'a stopped watch does not keep looking')
})
