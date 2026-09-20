import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('integrated server captures, pushes changes, saves, undoes, and preserves fallback without an engine', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dir = await mkdtemp(join(tmpdir(), 'december-jev-http-'))
  await writeFile(join(dir, '.jev-synthetic-preview'), 'synthetic')
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  probe.close(); await once(probe, 'close')
  const child = spawn(process.execPath, ['server.mjs'], { cwd:root, stdio:'pipe', env:{
    ...process.env, PORT:String(port), DECEMBER_DATA_DIR:dir, DECEMBER_JEV_MODE:'fast', DECEMBER_JEV_FIXTURE:'1',
    DECEMBER_CLAUDE:join(dir,'missing-claude'), DECEMBER_CODEX:join(dir,'missing-codex'),
  } })
  const exit = once(child, 'exit')
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  const streamAbort = new AbortController()
  t.after(async () => {
    streamAbort.abort()
    child.kill('SIGTERM'); await exit
    await rm(dir, { recursive:true,force:true })
    await rm(join(root, `mcp.${port}.json`), { force:true })
  })
  const base = `http://127.0.0.1:${port}`
  const api = async (path, body) => {
    const response = await fetch(base+path, { method:body ? 'POST':'GET',
      headers:body ? {'content-type':'application/json'} : {}, body:body ? JSON.stringify(body) : undefined })
    assert.ok(response.ok, `${path}: ${response.status}`)
    return response.json()
  }
  for (let n=0; n<100 && !log.includes('december listening'); n++) await new Promise(r => setTimeout(r, 30))
  assert.match(log, /december listening/)
  const stream = await fetch(base+'/api/changes', { signal:streamAbort.signal })
  assert.equal(stream.headers.get('content-type'), 'text/event-stream')
  const reader = stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/)
  const { result: space } = await api('/api/tool', { name:'december_create_space',arguments:{ name:'Groceries' } })
  await api('/api/tool', { name:'december_create_block',arguments:{ space:space.id,type:'list',title:'Groceries',items:['eggs'] } })
  const capture = await api('/api/capture', { text:'Add oat milk to Groceries',requestId:'jev-http-capture' })
  assert.equal(capture.settle.jev.provider, 'simulation')
  assert.notEqual(capture.settle.captureOnly, true)
  let page
  for (let n=0; n<100; n++) {
    page = await api('/api/state')
    if (page.settle.jev.outcome === 'appended' && !page.settle.running) break
    await new Promise(r => setTimeout(r,30))
  }
  assert.equal(page.settle.jev.outcome, 'appended')
  assert.equal(page.captures.length, 0)
  assert.ok(page.settle.timings.pass.count >= 1)
  assert.ok(page.settle.timings['jev-route'].count >= 1)
  assert.ok(page.settle.timings['tool:december_add_or_check'].count >= 1)
  assert.ok(!JSON.stringify(page.settle.timings).includes('oat milk'))
  assert.match(new TextDecoder().decode((await reader.read()).value), /changed/)
  assert.equal(page.spaces[0].blocks[0].items.filter(i=>i.text==='oat milk').length,1)
  await api('/api/undo', {})
  page = await api('/api/state')
  assert.equal(page.settle.jev.outcome, 'undone')
  assert.equal(page.captures.length,1)
  assert.equal(page.spaces[0].blocks[0].items.some(i=>i.text==='oat milk'),false)
  await api('/api/capture', {text:'Is my passport on the travel list?',requestId:'jev-question'})
  for (let n=0; n<100; n++) {
    page = await api('/api/state')
    if (page.settle.jev.outcome === 'fallback') break
    await new Promise(r=>setTimeout(r,30))
  }
  assert.equal(page.settle.jev.outcome,'fallback')
  assert.equal(page.captures.length,2)
  assert.match(page.settle.lastError, /preserved in the inbox/)
  await api('/api/capture', {text:'Make a Garden checklist: water herbs, repot basil, buy compost',requestId:'jev-http-create'})
  for (let n=0; n<100; n++) {
    page = await api('/api/state')
    if (page.settle.jev.outcome === 'created') break
    await new Promise(r=>setTimeout(r,30))
  }
  assert.equal(page.settle.jev.outcome,'created')
  const garden = page.spaces.find(s=>s.name==='Garden')
  assert.ok(garden)
  assert.deepEqual(garden.blocks[0].items.map(i=>i.text), ['water herbs','repot basil','buy compost'])
  assert.equal(page.captures.length,2)
  await api('/api/undo', {})
  page = await api('/api/state')
  assert.equal(page.settle.jev.outcome,'undone')
  assert.equal(page.spaces.some(s=>s.name==='Garden'),false)
  assert.equal(page.captures.length,3)

})
