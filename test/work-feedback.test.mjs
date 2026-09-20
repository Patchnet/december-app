import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {pendingView,filingPlan,runDestinations,passComplete} from '../public/js/work-feedback.js'

test('working stays truthful when another note is unsent; both retry states survive',()=>{
  const state={captures:[{id:'a',text:'Plumber'}],settle:{running:true,lastError:'old error'}}
  const local=[{id:'b',text:'Groceries',error:'offline'}]
  const view=pendingView(state,local)
  assert.equal(view.mode,'working')
  assert.equal(view.retryLocal,true)
  assert.equal(view.retryAgent,false)
  assert.equal(view.queue[0].status,'Received by December')
  assert.equal(view.queue[1].status,'Not sent yet · saved here')
  state.settle.running=false
  assert.equal(pendingView(state,local).retryAgent,true)
})
test('acknowledged submission is not counted twice while its outbox entry is removed',()=>{
  const view=pendingView({captures:[{id:'a:0',requestId:'a',text:'first'},{id:'a:1',requestId:'a',text:'second'}],settle:{}},[{id:'a',text:'first\nsecond'}])
  assert.equal(view.queue.length,2)
  assert.equal(new Set(view.queue.map(row=>row.id)).size,2)
  assert.equal(pendingView({captures:[],settle:{}},[]).show,false)
})
test('large batches animate at most three distinct visible destinations, without delaying the rest',()=>{
  const targets=Array.from({length:200},(_,i)=>({id:i}))
  const plan=filingPlan([...targets,targets[0]],target=>target.id!==0)
  assert.equal(plan.length,200)
  assert.deepEqual(plan.filter(p=>p.delay!==null).map(p=>p.delay),[0,160,320])
  assert.equal(plan[0].delay,null)
  assert.ok(filingPlan(targets,()=>false).every(p=>p.delay===null))
})
test('running passes hold results until final edits stop, including an empty inbox',()=>{
  assert.equal(passComplete({captures:[],settle:{running:true}},true),false)
  assert.equal(passComplete({captures:[],settle:{running:false}},true),true)
  assert.equal(passComplete({captures:[{id:'remaining'}],settle:{running:false,lastError:'failed'}},true),true)
  assert.equal(passComplete({captures:[{id:'waiting'}],settle:{}},false),false)
})
test('destinations deduplicate captures and ignore unrelated historical activity',()=>{
  const snapshot={captures:[{id:'b'}],settle:{running:true},activity:[{captureId:'a',space:'Work'},{captureId:'old',space:'Other'}],spaces:[{id:'work',name:'Work',blocks:[{items:[{src:'b'}]}]},{id:'other',name:'Other',blocks:[]}]}
  assert.deepEqual([...runDestinations(snapshot,new Set(['a','b']),()=> 'edit')],['work'])
  assert.deepEqual([...runDestinations(snapshot,new Set(['a','b']),()=> 'edit')],['work'])
})
test('date-only edits highlight the date in both compact and open cards',()=>{
  const source=readFileSync(new URL('../public/js/card-changes.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replaceAll('export function','function')
  const marks=[],fn=runInNewContext(source+';highlightCardChanges',{document:{hidden:false},CSS:{escape:x=>x},markEdited:el=>{if(el)marks.push(el)}})
  const before={name:'Plumber',blocks:[{id:'b',type:'reminder',text:'Call plumber',when:'2026-09-08'}]}
  const after=structuredClone(before);after.blocks[0].when='2026-09-09'
  const date={},solo={querySelector:s=>s==='.solo'?{}:s==='.solo-sub'?date:null}
  fn(solo,before,after);assert.deepEqual(marks,[date])
  marks.length=0
  const root={querySelector:s=>s==='.when-sub, .place-chip'?date:null}
  fn({querySelector:s=>s.startsWith('[data-bid')?root:null},before,after)
  assert.deepEqual(marks,[date])
})

 test('submission feedback starts before local retention and never claims unsaved text is saved',()=>{
  const pending = pendingView({captures:[],settle:{}},[],0,[{id:'draft',text:'play minecraft tonight'}])
  assert.equal(pending.mode,'retaining')
  assert.equal(pending.show,true)
  assert.equal(pending.queue[0].status,'Keeping your note')
  const retained = pendingView({captures:[],settle:{}},[{id:'saved',text:'play minecraft tonight'}],0,[{id:'draft',text:'play minecraft tonight'}])
  assert.equal(retained.queue.length,1)
  assert.equal(retained.mode,'sending')
})
