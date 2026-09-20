import {test} from 'node:test'
import assert from 'node:assert/strict'
import {runJevPass} from '../lib/jev-pass.mjs'
import {createJevProvider} from '../lib/jev-provider.mjs'

test('eligible captures drain in order and first ambiguity stops the fast pass',async()=>{
 const pending=['a','b','ambiguous','c'],seen=[]
 await runJevPass({pendingIds:()=>[...pending],attempt:async()=>{
  const id=pending[0];seen.push(id)
  if(id==='ambiguous')return {outcome:'fallback'}
  pending.shift();return {outcome:'appended',captureId:id}
 }})
 assert.deepEqual(seen,['a','b','ambiguous']);assert.deepEqual(pending,['ambiguous','c'])
})
test('new arrivals, missing progress, shadow and the pass budget cannot create an endless fast loop',async()=>{
 for(const scenario of ['arrival','no-progress','shadow','limit']){
  const pending=scenario==='limit'?['a','b','c']:['a'];let calls=0
  await runJevPass({limit:2,pendingIds:()=>[...pending],attempt:async()=>{
   calls++;const id=pending[0]
   if(scenario==='shadow')return {outcome:'would-append'}
   if(scenario!=='no-progress')pending.shift()
   if(scenario==='arrival')pending.push('new')
   return {outcome:'appended',captureId:id}
  }})
  assert.equal(calls,scenario==='limit'?2:1)
 }
})
test('partial mutation errors escape the fast pass without retrying or skipping captures',async()=>{
 let calls=0
 await assert.rejects(runJevPass({pendingIds:()=>['a','b'],attempt:async()=>{calls++;throw new Error('save failed')}}),/save failed/)
 assert.equal(calls,1)
})
test('provider cooldown skips calls and recovers through one probe',async()=>{
 let now=0,calls=0,fail=true,release
 const request=createJevProvider(async()=>{calls++;if(fail)throw new Error('offline');return new Promise(r=>{release=r})},{now:()=>now})
 for(let i=0;i<3;i++)await assert.rejects(request(),/offline/)
 await assert.rejects(request(),/temporarily unavailable/);assert.equal(calls,3)
 now=15000;fail=false;const probe=request()
 await assert.rejects(request(),/temporarily unavailable/);assert.equal(calls,4)
 release({ok:true});assert.deepEqual(await probe,{ok:true})
 const normal=request();assert.equal(calls,5);release({ok:true});await normal
})
