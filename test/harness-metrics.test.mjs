import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHarnessMetrics} from '../lib/harness-metrics.mjs'
test('timings preserve results and errors, bound history, and settle once',async()=>{
 let now=0;const m=createHarnessMetrics({now:()=>now,limit:2})
 const end=m.start('pass');now=10;end();now=50;end(true)
 assert.equal(m.snapshot().pass.count,1)
 assert.equal(m.snapshot().pass.latestMs,10)
 const value={ok:true};assert.equal(await m.measure('pass',()=>{now+=20;return value}),value)
 const error=new Error('private detail');await assert.rejects(m.measure('pass',()=>{now+=30;throw error}),e=>e===error)
 assert.deepEqual(m.snapshot().pass,{count:2,failures:1,latestMs:30,p50Ms:20,p95Ms:30})
 assert.ok(!JSON.stringify(m.snapshot()).includes('private detail'))
})
test('overlapping tool spans measure independently without inferring model latency',()=>{
 let now=0;const m=createHarnessMetrics({now:()=>now})
 const a=m.start('tool:a');now=10;const b=m.start('tool:b');now=25;a();now=30;b()
 assert.equal(m.snapshot()['tool:a'].latestMs,25);assert.equal(m.snapshot()['tool:b'].latestMs,20)
})
