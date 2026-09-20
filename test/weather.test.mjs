// The weather watch: a forecast, not a web page, and a card, not a capture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEATHER_TTL_MS, fetchWeather, weatherPlace, weatherSource } from '../lib/weather.mjs'
import { runWatchPass, dueAt, watchedBlocks } from '../lib/watch.mjs'
import { createPreviewStore, writePreview } from '../lib/previews.mjs'

const T0 = Date.parse('2026-09-18T16:00:00.000Z')

test('a weather ask names its place; anything else is not one', () => {
  assert.equal(weatherPlace('Weather in Tallahassee'), 'Tallahassee')
  assert.equal(weatherPlace('track the weather here in tallahassee'), 'tallahassee')
  assert.equal(weatherPlace('keep an eye on the weather for Lisbon, Portugal.'), 'Lisbon, Portugal')
  assert.equal(weatherPlace('Tallahassee weather'), 'Tallahassee')
  assert.equal(weatherPlace('New York forecast'), 'New York')
  assert.equal(weatherPlace('weather forecast for Miami'), 'Miami')
  assert.equal(weatherPlace('weather'), null, 'no place, nothing to look up')
  assert.equal(weatherPlace('track the weather here'), null)
  assert.equal(weatherPlace('UF football home schedule'), null)
  assert.equal(weatherPlace(''), null)
  assert.equal(weatherSource('Tallahassee'), weatherSource('  tallahassee '), 'one key per place, however it was typed')
})

const fakeMeteo = (calls) => async (url) => {
  calls.push(url)
  const body = url.includes('geocoding')
    ? { results: [{ name: 'Tallahassee', latitude: 30.44, longitude: -84.28, country_code: 'US', admin1: 'Florida', country: 'United States' }] }
    : { current: { temperature_2m: 29.1, apparent_temperature: 32, weather_code: 0, is_day: 1 } }
  return { ok: true, status: 200, json: async () => body }
}

test('the reading comes back shaped for the card', async () => {
  const calls = []
  const p = await fetchWeather('Tallahassee', { fetchImpl: fakeMeteo(calls), now: T0 })
  assert.equal(calls.length, 2, 'one geocode, one forecast')
  assert.match(calls[0], /geocoding-api\.open-meteo\.com.*name=Tallahassee/)
  assert.match(calls[1], /api\.open-meteo\.com.*latitude=30\.44.*current=temperature_2m/)
  assert.equal(p.kind, 'weather')
  assert.equal(p.location, 'Tallahassee, Florida')
  assert.equal(p.unit, 'F', 'a US place reads in Fahrenheit')
  assert.equal(p.celsius, 29.1)
  assert.equal(p.feelsCelsius, 32)
  assert.equal(p.code, 0)
  assert.equal(p.isDay, true)
  assert.equal(p.status, 'ready')
  assert.equal(p.observedAt, new Date(T0).toISOString())
  assert.equal(p.expiresAt, new Date(T0 + WEATHER_TTL_MS).toISOString())
  assert.equal(p.source, weatherSource('Tallahassee'))
})

test('a place the map does not know is an honest failure', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) })
  await assert.rejects(() => fetchWeather('Nowheresville', { fetchImpl }), /no place called "Nowheresville"/)
})

test('the pass writes the card and files nothing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dec-weather-'))
  const block = { id: 'w1', type: 'note', title: '', text: 'Weather in Tallahassee', entities: [], watch: { since: '2026-09-18T00:00:00.000Z' } }
  const page = { spaces: [{ id: 'sp', name: 'Weather', finished: false, blocks: [block] }] }
  assert.equal(watchedBlocks(page)[0].place, 'Tallahassee')

  const captures = []
  const searches = []
  let refreshed = 0
  const runs = {}
  const result = await runWatchPass({
    now: T0,
    page: () => page,
    dataDir,
    store: { read: async () => runs, write: async (next) => Object.assign(runs, next) },
    addCapture: async (text) => captures.push(text),
    searchWeb: async (q) => { searches.push(q); return { results: [] } },
    fetchWeather: (place, { now }) => fetchWeather(place, { fetchImpl: fakeMeteo([]), now }),
    onCaptured: () => { throw new Error('nothing should settle') },
    onRefreshed: () => refreshed++,
  })
  assert.deepEqual(result, { skipped: false, due: 1, captured: 0, refreshed: 1, failed: 0 })
  assert.equal(captures.length, 0, 'a forecast is never filed as prose')
  assert.equal(searches.length, 0, 'the search page is never asked')
  assert.equal(refreshed, 1)
  assert.equal(runs.w1.ok, true)
  assert.equal(runs.w1.kind, 'weather')
  assert.equal(dueAt(runs.w1), T0 + WEATHER_TTL_MS, 'a reading is good for an hour, not six')

  const rows = JSON.parse(await readFile(join(dataDir, 'previews', 'index.json'), 'utf8'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].location, 'Tallahassee, Florida')

  // and the page view finds the card from the block's own words
  const store = createPreviewStore(dataDir)
  const view = store.decorate({ spaces: page.spaces, captures: [] })
  assert.equal(view.spaces[0].blocks[0].preview.kind, 'weather')
  assert.equal(view.spaces[0].blocks[0].text, 'Weather in Tallahassee', 'the words are untouched')
})

test('writePreview replaces an earlier reading for the same place', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dec-preview-'))
  const base = { kind: 'weather', source: weatherSource('Lisbon'), location: 'Lisbon', code: 1, isDay: true, celsius: 20, unit: 'C', status: 'ready' }
  await writePreview(dataDir, base)
  await writePreview(dataDir, { ...base, celsius: 24 })
  const rows = JSON.parse(await readFile(join(dataDir, 'previews', 'index.json'), 'utf8'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].celsius, 24)
  await assert.rejects(() => writePreview(dataDir, { kind: 'weather' }), /invalid preview data/)
})
