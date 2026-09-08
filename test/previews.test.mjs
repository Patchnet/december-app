import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createPreviewStore } from '../lib/previews.mjs'
import { WEATHER_CODES, weatherFor, temperature, normalizePreview, previewHTML, previewNoteText } from '../public/js/preview-model.js'
import { BLOCK_TYPES, createBlockFields } from '../lib/blocks.mjs'
import { softWeatherIcon } from '../public/js/soft-weather.js'

test('soft weather family covers the provider mapping and gives each instance unique definitions', () => {
  const ids = new Set()
  for (const code of Object.keys(WEATHER_CODES).map(Number)) for (const day of [true,false]) {
    const {icon,label} = weatherFor(code,day)
    const svg = softWeatherIcon(icon,label)
    assert.match(svg, /<svg/)
    assert.ok(svg.includes(`aria-label="${label}"`))
    assert.doesNotMatch(svg, /<script|<animate|<image/)
    for (const [,id] of svg.matchAll(/\bid="([^"]+)"/g)) {
      assert.ok(!ids.has(id),`duplicate definition ${id}`)
      ids.add(id)
    }
  }
  assert.doesNotMatch(softWeatherIcon('not-available','<script>'), /aria-label="<script>/)
})

test('all 28 provider codes have local icons in both day and night modes', () => {
  const codes = [0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99]
  assert.deepEqual(Object.keys(WEATHER_CODES).map(Number), codes)
  for (const c of codes) for (const day of [true, false]) {
    const w = weatherFor(c, day)
    assert.notEqual(w.icon, 'not-available')
    const path = new URL(`../public/preview-icons/${w.icon}.svg`, import.meta.url)
    assert.ok(existsSync(path), `${c}/${day}: ${w.icon}`)
    assert.doesNotMatch(readFileSync(path, 'utf8'), /<script|<animate|https?:\/\/(?!www.w3.org)/)
  }
  assert.equal(weatherFor(null, true).icon, 'not-available')
  assert.equal(weatherFor(999, true).icon, 'not-available')
  assert.equal(weatherFor(0, null).icon, 'not-available')
})

test('temperature is data, including zero, negative values, and absence', () => {
  assert.equal(temperature(0), '0°C')
  assert.equal(temperature(0, 'F'), '32°F')
  assert.equal(temperature(-40, 'F'), '-40°F')
  for (const v of [null, undefined, NaN, Infinity, '18']) assert.equal(temperature(v), '—')
})

test('missing, unknown, stale, and unsafe display data degrade honestly', () => {
  const w = {kind:'weather',source:'https://open-meteo.com/',status:'ready',code:65,isDay:true,celsius:12,expiresAt:'2026-01-01T12:00:00Z'}
  assert.match(previewHTML(w, Date.parse('2026-01-02')), /may be out of date/)
  assert.match(previewHTML({...w,status:'unavailable'}), /Weather unavailable/)
  assert.doesNotMatch(previewHTML({...w,status:'unavailable'}), /12°C/)
  assert.match(previewHTML({...w,code:999}), /Condition unavailable/)
  assert.equal(previewHTML(null), '')
  assert.equal(normalizePreview({kind:'image',source:'javascript:alert(1)',asset:'a'.repeat(64)+'.jpg'}), null)
  assert.equal(normalizePreview({kind:'image',source:'https://example.com',asset:'../../secret.jpg'}), null)
  assert.equal(normalizePreview({...w,celsius:Infinity}).celsius, null)
  const html = previewHTML({...w,location:'<script>alert(1)</script>'})
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('decoration preserves every block and does not mutate stored or agent data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-preview-'))
  try {
    mkdirSync(join(dir,'previews','assets'), {recursive:true})
    const image = {kind:'image',source:'https://example.com/recipe',asset:'a'.repeat(64)+'.jpg',alt:'A dish'}
    writeFileSync(join(dir,'previews','index.json'), JSON.stringify([image]))
    const store = createPreviewStore(dir)
    const body = {captures:[],spaces:[{id:'s',updatedAt:'original',blocks:[{id:'n',type:'note',text:'Save https://example.com/recipe'},{id:'l',type:'list',items:[{id:'i',text:'Milk',done:false}]},{id:'n2',type:'note',text:'https://example.com/recipe'}]}]}
    const before = JSON.stringify(body)
    const shown = store.decorate(body)
    assert.equal(shown.spaces[0].blocks[0].preview.kind, 'image')
    assert.equal(shown.spaces[0].blocks[2].preview, undefined, 'one preview per space')
    assert.deepEqual(shown.spaces[0].blocks[1], body.spaces[0].blocks[1])
    assert.equal(shown.spaces[0].updatedAt, 'original')
    assert.equal(JSON.stringify(body), before)
    assert.equal(store.decorate({result:body}).result, body, 'tool result untouched')
    const agent = {spaces:body.spaces}
    assert.equal(store.decorate(agent), agent)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('bad cache never prevents text rendering; image assets cannot escape their directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-preview-'))
  try {
    mkdirSync(join(dir,'previews','assets'), {recursive:true})
    writeFileSync(join(dir,'previews','index.json'), 'broken JSON')
    const store = createPreviewStore(dir)
    const body = {captures:[],spaces:[{blocks:[{type:'note',text:'Your note'}]}]}
    assert.equal(store.decorate(body).spaces[0].blocks[0].text, 'Your note')
    assert.equal(store.asset('../../secret.jpg'), null)
    const bytes = Buffer.from([255,216,255,219,0,1,2,3])
    const name = createHash('sha256').update(bytes).digest('hex')+'.jpg'
    writeFileSync(join(dir,'previews','assets',name), bytes)
    assert.equal(store.asset(name).type, 'image/jpeg')
    writeFileSync(join(dir,'outside.jpg'),bytes)
    const alias = 'b'.repeat(64)+'.jpg'
    symlinkSync(join(dir,'outside.jpg'),join(dir,'previews','assets',alias))
    assert.equal(store.asset(alias),null)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('agent retains its six primitives with no presentation choices', () => {
  assert.deepEqual(BLOCK_TYPES, ['list','tracker','ledger','streak','note','reminder'])
  const fields = createBlockFields()
  for (const key of ['preview','recipe','weather','image','layout','skin']) assert.equal(fields[key], undefined)
})

test('forecast expiry invalidates presentation without touching the note timestamp', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dec-preview-expiry-'))
  let now = Date.parse('2026-09-07T12:00:00Z')
  t.mock.method(Date, 'now', () => now)
  try {
    mkdirSync(join(dir,'previews'),{recursive:true})
    writeFileSync(join(dir,'previews','index.json'),JSON.stringify([{kind:'weather',source:'https://example.com/weather',status:'ready',code:0,isDay:true,celsius:18,expiresAt:'2026-09-07T12:00:01Z'}]))
    const store = createPreviewStore(dir)
    const before = store.revision()
    now += 2000
    assert.notEqual(store.revision(),before)
    const shown = store.decorate({captures:[],spaces:[{updatedAt:'original',blocks:[{type:'note',text:'https://example.com/weather'}]}]})
    assert.equal(shown.spaces[0].updatedAt,'original')
    assert.match(previewHTML(shown.spaces[0].blocks[0].preview), /may be out of date/)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

test('compact preview source collapse preserves prose, distinct links and full notes', () => {
  const p = {kind:'image',source:'https://example.com/recipe',asset:'a'.repeat(64)+'.jpg'}
  const original = 'Sunday dinner.\nhttps://example.com/recipe'
  assert.equal(previewNoteText(original,p),'Sunday dinner.')
  assert.equal(previewNoteText(original,p,true),original)
  assert.equal(previewNoteText(original,{...p,asset:'invalid'}),original)
  for (const text of ['See https://example.com/recipe for details.', 'https://example.com/recipe#method', 'https://example.com/another']) {
    assert.equal(previewNoteText(text,p),text)
  }
  assert.equal(previewNoteText(p.source,p),'')
})
