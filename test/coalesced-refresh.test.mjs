import {test} from 'node:test'
import assert from 'node:assert/strict'
import {coalescedRefresh} from '../public/js/coalesced-refresh.js'
test('invalidation burst queues one trailing read without parallel requests',async()=>{
 const pending=[];let calls=0
 const refresh=coalescedRefresh(()=>{calls++;return new Promise(r=>pending.push(r))})
 const first=refresh();for(let i=0;i<50;i++)refresh()
 assert.equal(calls,1);pending.shift()();await new Promise(r=>setImmediate(r))
 assert.equal(calls,2);pending.shift()();await first;assert.equal(calls,2)
 const next=refresh();assert.equal(calls,3);pending.shift()();await next
})
test('a failed read does not wedge future refreshes',async()=>{
 let fails=true;const refresh=coalescedRefresh(async()=>{if(fails)throw new Error('offline')})
 await assert.rejects(refresh(),/offline/);fails=false;await refresh()
})
