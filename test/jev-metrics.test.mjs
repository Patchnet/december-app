import {test} from 'node:test'
import assert from 'node:assert/strict'
import {recordJev,jevMetrics} from '../lib/jev-metrics.mjs'
test('diagnostics are bounded, aggregate timings and omit content',()=>{
 for(let i=0;i<105;i++)recordJev({outcome:'fallback',reason:'outside-fast-path',requestMs:i,secret:'never retain'})
 const m=jevMetrics();assert.equal(m.samples,100);assert.equal(m.requestMs.p50,54);assert.equal(m.requestMs.p95,99);assert.equal(m.fallbacks['outside-fast-path'],100);assert.ok(!JSON.stringify(m).includes('never retain'))
})
