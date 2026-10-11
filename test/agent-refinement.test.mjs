import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createAgentScheduler,createCaptureDebounce} from '../lib/agent-scheduler.mjs'
import {compactAgentView,boundedRecords} from '../lib/agent-context.mjs'
import {queryContext,factualAnswer,exactTotal} from '../lib/query.mjs'
import {createSearchIndex,searchIndex} from '../public/js/search-index.js'
import {localDayAfter,reminderIdentity} from '../public/js/calendar-order.js'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('foreground preempts and retries background with fresh inputs; jobs never overlap',async()=>{
  const scheduler=createAgentScheduler(),calls=[]
  let attempts=0
  const background=scheduler.enqueue('journal',async signal=>{
    calls.push(`background:${++attempts}`)
    if(attempts===1)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
    return attempts
  },{background:true})
  await tick()
  const foreground=scheduler.enqueue('organize',async()=>{calls.push('organize')})
  await foreground;assert.equal(await background,2)
  assert.deepEqual(calls,['background:1','organize','background:2'])
  scheduler.close()
})

test('cancelled queued questions never launch and repeated job keys coalesce',async()=>{
  const scheduler=createAgentScheduler()
  let release
  const busy=scheduler.enqueue('organize',()=>new Promise(r=>{release=r}))
  await tick()
  assert.equal(scheduler.enqueue('organize',()=>assert.fail('duplicate')),busy)
  const controller=new AbortController()
  const question=scheduler.enqueue('q',()=>assert.fail('cancelled job ran'),{signal:controller.signal})
  controller.abort();await assert.rejects(question,/cancelled/)
  release();await busy;scheduler.close()
})

test('continuous submissions respect the first capture maximum wait',()=>{
  let now=0,next,runs=0
  const debounce=createCaptureDebounce(()=>runs++,{now:()=>now,setTimer:(f,ms)=>{next={f,at:now+ms};return 1},clearTimer:()=>{}})
  for(now=0;now<=450;now+=90)debounce.schedule()
  assert.equal(next.at,500);next.f();assert.equal(runs,1)
  now=700;debounce.schedule();assert.equal(next.at,850)
})

test('compact context preserves catalog coverage and oversized spaces remain discoverable',()=>{
  const view={captures:[],spaces:Array.from({length:100},(_,i)=>({id:`s${i}`,name:`Subject ${i}`,blocks:[{id:`b${i}`,type:'note',text:'detail '.repeat(3000)}]}))}
  const compact=compactAgentView(view)
  assert.equal(compact.spaces.length,100)
  assert.ok(JSON.stringify(compact).length<JSON.stringify(view).length/20)
  assert.equal(compact.spaces[0].blocks[0].detailRequired,true)
  const tiny=compactAgentView(view,{maxBytes:1})
  assert.equal(tiny.spaces[0].id,'s0');assert.equal(tiny.coverage.nextOffset,1)
  assert.equal(boundedRecords([{a:1},{b:2}],{limit:1}).nextOffset,1)
})

test('query reads old entries and late note text; arithmetic never uses the recent eight',()=>{
  const entries=Array.from({length:30},(_,i)=>({id:`e${i}`,amount:'0.10',label:i===0?'Old repair':'Fuel'}))
  const page={revision:4,spaces:[{id:'car',name:'Car',blocks:[{id:'ledger',type:'ledger',unit:'$',entries},{id:'note',type:'note',text:'x'.repeat(4000)+' insurance policy'}]}]}
  const result=queryContext(page,'old repair')
  assert.equal(result.records[0].entry.id,'e0')
  assert.ok(queryContext(page,'insurance').records.some(r=>r.text?.includes('policy')))
  assert.equal(factualAnswer(page,'What is the total for Car?').answer,'$3.00 in Car, across 30 entries.')
  assert.equal(factualAnswer(page,'What is the total for Car last month?'),null)
  assert.equal(exactTotal([{amount:0.1},{amount:0.2}]),'0.30')
  assert.equal(exactTotal([{amount:0.001}]),null)
  const paged=queryContext(page,'car',{maxBytes:500})
  assert.equal(paged.coverage.complete,false)
  assert.ok(queryContext(page,'car',{offset:paged.coverage.nextOffset}).records.length>0)
})

test('ranking considers late exact matches and keeps separate equal labels',()=>{
  const spaces=Array.from({length:12},(_,i)=>({id:`s${i}`,name:i===11?'Rent':`Rent notes ${i}`,blocks:[{id:`b${i}`,type:'reminder',text:'Pay rent',when:'2026-10-20'}]}))
  const index=createSearchIndex(spaces)
  assert.equal(searchIndex(index,'rent')[0].sid,'s11')
  assert.equal(searchIndex(index,'pay rent',{limit:20}).length,12)
  assert.notEqual(reminderIdentity(spaces[0],spaces[0].blocks[0]),reminderIdentity(spaces[1],spaces[1].blocks[0]))
  assert.equal(localDayAfter(7,new Date(2026,9,30,23,30)),'2026-11-06')
})

let serial=0
async function coreFixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'december-refine-'))
  process.env.DECEMBER_DATA_DIR=dir
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const load=()=>import(`../lib/core.mjs?refinement=${++serial}`)
  return {dir,core:await load(),load}
}

test('block preconditions reject stale writes while unrelated changes remain valid',async t=>{
  const {core}=await coreFixture(t)
  const s=await core.createSpace('Home')
  const {blockId}=await core.createBlock(s.id,{type:'note',text:'Original'})
  const version=core.readBlock(blockId).version
  await core.addCapture('Unrelated')
  assert.doesNotThrow(()=>core.validateCommand('december_write_note',{blockId,expectedVersion:version}))
  await core.updateBlock(blockId,{note_text:'Changed'},'note')
  assert.throws(()=>core.validateCommand('december_write_note',{blockId,expectedVersion:version}),e=>e.code==='VERSION_CONFLICT')
})

test('organizer batch excludes arrivals and never changes external views',async t=>{
  const {core}=await coreFixture(t)
  await core.addCapture('First');await core.addCapture('Second')
  const [id]=core.beginOrganizerBatch(1)
  await core.addCapture('Third')
  assert.deepEqual(core.organizerView().captures.map(c=>c.id),[id])
  assert.equal(core.agentView().captures.length,3)
  assert.throws(()=>core.validateCommand('december_file_capture',{captureId:'other'},{organizer:true}),/outside/)
  core.endOrganizerBatch()
  assert.throws(()=>core.validateCommand('december_create_space',{name:'Oops'},{organizer:true}),/No active/)
})

test('archived receipts replay across restart and a corrupt archive fails closed',async t=>{
  const {dir,core,load}=await coreFixture(t)
  const space=await core.createSpace('Home')
  const capture=await core.addCapture('One note')
  const args={space:space.id,type:'note',text:'Preserved',source:capture.id,operationId:'jev-create-v1'}
  const first=await core.executeAgentOperation('december_create_block',args,()=>core.createBlock(space.id,args))
  await core.fileCapture(capture.id,space.id,'Saved')
  // Begin an independent undo group so an old group may be archived.
  core.beginAgentRun();await core.createSpace('Other')
  assert.equal(await core.compactOperations({retain:0,threshold:0}),1)
  assert.equal(JSON.parse(await readFile(join(dir,'operation-archive.json'),'utf8')).length,1)
  const output=join(dir,'rehydrated.json')
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/restore-operation-receipts.mjs',import.meta.url)),join(dir,'state.json'),join(dir,'operation-archive.json'),output])
  const rehydrated=JSON.parse(await readFile(output,'utf8'))
  assert.equal(rehydrated.operations.length,1)
  assert.equal(rehydrated.operationArchiveRequired,undefined)
  const restarted=await load()
  assert.deepEqual(await restarted.executeAgentOperation('december_create_block',args,()=>assert.fail('replayed mutation')),first)
  await writeFile(join(dir,'operation-archive.json'),'broken')
  await assert.rejects(load())
})

test('date-filtered ledger totals use complete entries independently of record pagination',()=>{
  const page={revision:1,spaces:[{id:'s',name:'Car',blocks:[{id:'b',type:'ledger',unit:'$',entries:[
    {id:'old',label:'Repair',amount:3.1,at:'2026-09-10T12:00:00Z'},
    {id:'new',label:'Fuel',amount:2.2,at:'2026-10-10T12:00:00Z'},
  ]}]}]}
  const result=queryContext(page,'car',{from:'2026-09-01',until:'2026-09-30',maxBytes:1})
  assert.equal(result.coverage.complete,false)
  assert.equal(result.aggregates[0].total,'3.10')
  assert.equal(result.aggregates[0].complete,true)
  assert.throws(()=>queryContext(page,'car',{from:'2026-02-30'}))
})
