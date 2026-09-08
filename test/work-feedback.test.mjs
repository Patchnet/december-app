import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {pendingView,filingPlan} from '../public/js/work-feedback.js'

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
test('terminal failure releases saved cards even with unfiled captures',()=>{
  const source=readFileSync(new URL('../public/js/layout.js',import.meta.url),'utf8')
  const fn=source.slice(source.indexOf('function releaseHeld('),source.indexOf('\n/** Keep the existing thought stack'))
  const card={dataset:{sid:'saved'}},released=[]
  const state={captures:[{id:'remaining'}],settle:{running:false,lastError:'failed'}}
  const release=runInNewContext(fn+';releaseHeld',{page:{state},document:{querySelectorAll:()=>[card]},unbuild:el=>released.push(el)})
  release(new Map([['remaining','saved']]))
  assert.deepEqual(released,[card])
  released.length=0;state.settle.running=true
  release(new Map())
  assert.equal(released.length,0)
})
test('date-only edits highlight the date in both compact and open cards',()=>{
  const source=readFileSync(new URL('../public/js/card-changes.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace('export function','function')
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
