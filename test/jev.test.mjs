import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryJevCapture, fixtureDecision, jevConfig, fastCaptureDelay } from '../lib/jev.mjs'
import { MODEL, callJev, parseAppend } from '../lib/jev-router.mjs'

const config = { mode: 'fast', ready: true, fixture: false, key: 'test-only' }
test('only an eligible single submission skips the debounce', () => {
  const h = harness()
  assert.equal(fastCaptureDelay(h.view,config),0)
  assert.equal(fastCaptureDelay(h.view,{...config,mode:'off'}),700)
  assert.equal(fastCaptureDelay(h.view,{...config,ready:false}),700)
  h.view.captures.push({id:'second',text:'Add rice to Groceries'})
  assert.equal(fastCaptureDelay(h.view,config),0)
  h.view.captures[1].hint='space'
  assert.equal(fastCaptureDelay(h.view,config),700)
  h.view.captures.pop()
  h.view.lessons.push('Ask before filing')
  assert.equal(fastCaptureDelay(h.view,config),700)
})
function harness(text = 'Add oat milk to Groceries') {
  const view = { lessons: [], ask: null, captures: [{ id: 'capture', text }],
    spaces: [{ id: 'space', blocks: [{ id: 'list', title: 'Groceries', type: 'list', items: [{ text: 'eggs' }] }] }] }
  let revision = 1
  const writes = []
  const core = { agentView: () => view, stateRevision: () => revision }
  return { core, view, writes, change: () => revision++, config,
    request: fixtureDecision, callTool: async (name, args) => { writes.push({ name, args }) } }
}

test('Jev is disabled by default; simulation requires an explicit synthetic data marker', async t => {
  assert.equal(jevConfig({}).mode, 'off')
  assert.equal(jevConfig({ DECEMBER_JEV_MODE: 'fast', DECEMBER_JEV_FIXTURE: '1' }).fixture, false)
  const dir = await mkdtemp(join(tmpdir(), 'december-jev-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, '.jev-synthetic-preview'), 'synthetic data only')
  assert.equal(jevConfig({ DECEMBER_JEV_MODE: 'fast', DECEMBER_JEV_FIXTURE: '1', DECEMBER_DATA_DIR: dir }).fixture, true)
  const h = harness()
  h.request = () => { throw new Error('must not call') }
  assert.equal((await tryJevCapture({ ...h, config: { ...config, mode: 'off' } })).outcome, 'off')
  assert.equal((await tryJevCapture({ ...h, config: { ...config, ready: false } })).outcome, 'unconfigured')
  assert.equal(h.writes.length, 0)
})

test('explicit append uses stable source receipts; shadow never writes', async () => {
  const h = harness()
  assert.equal((await tryJevCapture(h)).outcome, 'appended')
  assert.deepEqual(h.writes.map(w => w.name), ['december_add_or_check', 'december_file_capture'])
  assert.deepEqual(h.writes[0].args, { blockId: 'list', add: ['oat milk'], source: 'capture', operationId: 'jev-append-v1' })
  const shadow = harness()
  assert.equal((await tryJevCapture({ ...shadow, config: { ...config, mode: 'shadow' } })).outcome, 'would-append')
  assert.equal(shadow.writes.length, 0)
})

test('questions, negations, mixed requests, duplicates, lessons and partial receipts defer', async () => {
  for (const text of ['Is my passport on the travel list?', "Don't add milk to Groceries", 'Add milk and eggs to Groceries', 'Add eggs to Groceries', 'Add milk to an unknown list']) {
    const h = harness(text)
    h.request = () => { throw new Error('ineligible input must not call provider') }
    assert.equal((await tryJevCapture(h)).outcome, 'fallback')
    assert.equal(h.writes.length, 0)
  }
  for (const edit of [h => h.view.lessons.push('Check before filing'), h => { h.view.ask = { question: 'Which one?' } }, h => { h.view.captures[0].appliedOperations = [{}] }]) {
    const h = harness(); edit(h)
    assert.equal((await tryJevCapture(h)).reason, 'context-needs-organizer')
    assert.equal(h.writes.length, 0)
  }
})

test('old completed duplicates are checked against the full block, not the lean view', async () => {
  const h = harness()
  h.core.readBlock = () => ({ block: { items: [{ text: 'oat milk', done: true }] } })
  assert.equal((await tryJevCapture(h)).outcome, 'fallback')
  assert.equal(h.writes.length, 0)
  assert.equal(parseAppend(`Add ${'x'.repeat(170)} to Groceries`, [{ id:'list',name:'Groceries',items:[] }]), null)
})

test('concurrent page changes and malformed, low-confidence or wrong-version responses cannot write', async () => {
  for (const mutate of [
    (r, h) => h.change(),
    r => { r.data.model = 'different-model' },
    r => { r.data.answers.action.confidence = 0.91 },
    r => { r.data.answers.target.choice = 'invented' },
    r => { r.data.answers.action.probabilities.append = 0.2 },
  ]) {
    const h = harness()
    h.request = async req => { const r = await fixtureDecision(req); mutate(r, h); return r }
    assert.equal((await tryJevCapture(h)).outcome, 'fallback')
    assert.equal(h.writes.length, 0)
  }
})

test('provider errors fall back without exposing secrets; mutation failure never falsely files', async () => {
  const h = harness()
  h.request = async () => { throw new Error('private-provider-body') }
  const result = await tryJevCapture(h)
  assert.equal(result.reason, 'provider-unavailable')
  assert.ok(!JSON.stringify(result).includes('private-provider-body'))
  const failing = harness()
  failing.callTool = async (name) => { failing.writes.push(name); throw new Error('disk failure') }
  await assert.rejects(tryJevCapture(failing), /disk failure/)
  assert.deepEqual(failing.writes, ['december_add_or_check'])
})

test('live HTTP adapter pins the model, redacts provider errors and has a bounded timeout', async () => {
  let aborted = false
  await assert.rejects(callJev({ model: MODEL }, { apiKey:'private-key', timeoutMs:10,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
      assert.equal(options.headers.Authorization, 'Bearer private-key')
      return new Promise((resolve, reject) => {
        const keepAlive = setTimeout(resolve, 1000)
        options.signal.addEventListener('abort', () => { aborted = true; clearTimeout(keepAlive); reject(options.signal.reason) })
      })
    },
  }), /TypeSafe timeout/)
  assert.equal(aborted, true)
  await assert.rejects(callJev({ model:MODEL }, { apiKey:'private-key', fetchImpl: async () => ({ok:false,status:429}) }), /^Error: TypeSafe HTTP 429$/)
})

test('real December tools persist the append and filing, deduplicate retries, and undo both', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'december-jev-integration-'))
  const previous = process.env.DECEMBER_DATA_DIR
  process.env.DECEMBER_DATA_DIR = dir
  t.after(async () => {
    if (previous === undefined) delete process.env.DECEMBER_DATA_DIR
    else process.env.DECEMBER_DATA_DIR = previous
    await rm(dir, { recursive: true, force: true })
  })
  const core = await import('../lib/core.mjs')
  const { callTool } = await import('../lib/tools.mjs')
  const space = await core.createSpace('Groceries')
  const block = await core.createBlock(space.id, { type:'list',title:'Groceries',items:['eggs'] })
  await core.addCapture('Add oat milk to Groceries')
  const captureId = core.agentView().captures[0].id
  core.beginAgentRun()
  const result = await tryJevCapture({ core, callTool, config, request:fixtureDecision })
  assert.equal(result.outcome, 'appended')
  assert.equal(core.hasInbox(), false)
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(saved.operations.filter(o => o.source === captureId).length, 2)
  assert.equal(saved.captures[0].status, 'filed')
  await callTool('december_add_or_check', { blockId:block.blockId,add:['oat milk'],source:captureId,operationId:'jev-append-v1' })
  assert.equal(core.readBlock(block.blockId).block.items.filter(i => i.text === 'oat milk').length, 1)
  const restarted = await import('../lib/core.mjs?jev-restart')
  assert.equal(restarted.readBlock(block.blockId).block.items.some(i => i.text === 'oat milk'), true)
  await core.undo()
  assert.equal(core.readBlock(block.blockId).block.items.some(i => i.text === 'oat milk'), false)
  assert.equal(core.hasInbox(), true)
  assert.equal((await tryJevCapture({ core, callTool, config, request:fixtureDecision })).outcome, 'fallback')
})

 test('explicit batches write once and send only the selected list', async()=>{
  const h=harness('Add milk, bread, and apples to Groceries')
  h.view.spaces.push({id:'private',blocks:[{id:'other',type:'list',title:'Unrelated',items:[{text:'private unrelated content'}]}]})
  h.request=async req=>{
    assert.equal(req.state.lists.length,1)
    assert.ok(!JSON.stringify(req).includes('private unrelated content'))
    const answer=await fixtureDecision({...req,state:{...req.state,capture:'Add oat milk to Groceries'}})
    return answer
  }
  const result=await tryJevCapture(h)
  assert.equal(result.outcome,'appended')
  assert.deepEqual(h.writes[0].args.add,['milk','bread','apples'])
  assert.equal(h.writes.length,2)
  assert.equal(result.itemCount,3)
  assert.ok(result.saveMs>=0)
})
test('batch ambiguity and any duplicate defer the entire request without partial writes',async()=>{
  for(const text of ['Add milk, eggs to Groceries','Add milk, MILK to Groceries','Add milk,,bread to Groceries','Add mac and cheese, bread to Groceries','Add milk, remove bread to Groceries']){
    const h=harness(text);h.request=()=>{throw new Error('must not request')}
    assert.equal((await tryJevCapture(h)).outcome,'fallback');assert.equal(h.writes.length,0)
  }
})

test('routing hydrates only its destination, while unrelated and ineligible captures do no full reads',async()=>{
 const h=harness();const reads=[]
 h.view.spaces.push({id:'other',blocks:[{id:'private',type:'list',title:'Other',items:[]}]})
 h.core.readBlock=id=>{reads.push(id);return {block:{items:[{text:'eggs'}]}}}
 assert.equal((await tryJevCapture(h)).outcome,'appended')
 assert.deepEqual(reads,['list','list'])
 reads.length=0;h.view.captures[0].text='What should I do today?'
 assert.equal((await tryJevCapture(h)).outcome,'fallback');assert.deepEqual(reads,[])
})
