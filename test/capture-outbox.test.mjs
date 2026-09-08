import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createCaptureOutbox} from '../public/js/capture-outbox.js'
import {parseCaptureInput} from '../public/js/capture-input.js'
import {reconcileState} from '../public/js/state-sync.js'

function storeFixture(){const records=new Map();return {records,list:async()=>structuredClone([...records.values()]),put:async item=>records.set(item.id,structuredClone(item)),remove:async id=>records.delete(id)}}
const ack=job=>({captureReceipt:{requestId:job.id},spaces:[],captures:[],revision:1})

test('a lost acknowledgement survives reload and reuses the same request and context',async()=>{
 const store=storeFixture(),seen=[]
 const first=createCaptureOutbox({store,makeId:()=> 'stable-id',send:async job=>{seen.push(job);throw new Error('response lost')}})
 await first.enqueue('A note','Work');await first.flush()
 assert.equal(store.records.size,1)
 const restarted=createCaptureOutbox({store,send:async job=>{seen.push(job);return ack(job)}})
 await restarted.flush()
 assert.equal(store.records.size,0)
 assert.equal(seen[0].id,seen[1].id);assert.equal(seen[1].hint,'Work');assert.equal(seen[1].text,'A note')
})
test('unmatched receipts retain the request and independent notes still send',async()=>{
 const store=storeFixture();let sequence=0
 const box=createCaptureOutbox({store,makeId:()=>String(++sequence),send:async job=>job.id==='1'?{captureReceipt:{requestId:'other'}}:ack(job)})
 await box.enqueue('First');await box.enqueue('Second');await box.flush()
 assert.deepEqual([...store.records.keys()],['1']);assert.match(store.records.get('1').error,/acknowledge/)
})
test('a failed local save rejects enqueue without claiming the draft was retained',async()=>{
 const store=storeFixture();store.put=async()=>{throw new Error('disk quota')}
 const box=createCaptureOutbox({store,send:async()=>assert.fail('must not send'),makeId:()=> '1'})
 await assert.rejects(box.enqueue('Do not clear this'),/disk quota/);assert.equal(store.records.size,0)
})
test('enqueue during a pending delivery joins the same flush without duplicate requests',async()=>{
 const store=storeFixture(),sent=[];let release,sequence=0
 const box=createCaptureOutbox({store,makeId:()=>String(++sequence),send:async job=>{sent.push(job.id);if(job.id==='1')await new Promise(resolve=>{release=resolve});return ack(job)}})
 await box.enqueue('A');const first=box.flush();while(!release)await new Promise(resolve=>setImmediate(resolve))
 await box.enqueue('B');const second=box.flush();assert.equal(first,second);release();await first
 assert.deepEqual(sent,['1','2']);assert.equal(store.records.size,0)
})
test('all-or-nothing input validation preserves ordinary short lines',()=>{
 assert.deepEqual(parseCaptureInput('- AC\n• Rx\ngym'),['AC','Rx','gym'])
 assert.throws(()=>parseCaptureInput(Array.from({length:26},(_,i)=>`line ${i}`).join('\n')),/25/)
 assert.throws(()=>parseCaptureInput('short\n'+'x'.repeat(8001)),/8,000/)
})
test('both mutation snapshots and poll envelopes obey monotonic state adoption',()=>{
 const current={revision:12,spaces:[{id:'new-card'}],captures:[],settle:{running:true},fingerprint:'new'}
 assert.equal(reconcileState(current,{revision:11,spaces:[],captures:[]}),current)
 assert.equal(reconcileState(current,{revision:13,spaces:[]}),current)
 assert.equal(reconcileState(current,{unchanged:true,revision:11,settle:{running:false}}),current)
 const next=reconcileState(current,{unchanged:true,revision:12,settle:{running:false}})
 assert.deepEqual(next.spaces,current.spaces);assert.equal(next.settle.running,false)
 assert.equal(reconcileState(current,{revision:13,spaces:[],captures:[]}).revision,13)
})
