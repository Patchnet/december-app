import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
const source=readFileSync(new URL('../public/js/stage-context.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/^export /gm,'')
const {stageReceipts}=runInNewContext(source+'\n;({stageReceipts})',{WeakMap})

test('stage receipts preserve server ordering and link only to an unambiguous live card',()=>{
  const activity=[{at:'2026-09-07T14:00:00Z',space:'Reading',summary:'Logged a book'},{at:'2026-09-07T13:00:00Z',space:'Trip',summary:'Updated the plan'}]
  const rows=stageReceipts({activity,spaces:[{id:'books',name:'Reading'},{id:'trip',name:'Trip',finished:true}]})
  assert.equal(rows[0].summary,'Logged a book')
  assert.equal(rows[0].sid,'books')
  assert.equal(rows[1].sid,null)
  assert.equal(activity[0].sid,undefined)
})

test('missing and ambiguous destinations remain readable without a misleading open action',()=>{
  const rows=stageReceipts({activity:[{space:'Same'},{space:'Removed'}],spaces:[{id:'a',name:'Same'},{id:'b',name:'Same'}]})
  assert.equal(rows[0].sid,null)
  assert.equal(rows[1].sid,null)
  assert.equal(stageReceipts({}).length,0)
})
