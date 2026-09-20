import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
const source=readFileSync(new URL('../public/js/confirmed-completion.js',import.meta.url),'utf8')
const fn=source.slice(source.indexOf('export function newlyDone'),source.indexOf('/** The same row')).replace('export ','')
const newlyDone=runInNewContext(fn+';newlyDone')
test('only existing tasks changing from open to done earn completion motion',()=>{
 const before={blocks:[{id:'list',type:'list',items:[{id:'a',done:false},{id:'b',done:true}]},{id:'rem',type:'reminder',done:false}]}
 const after=structuredClone(before);after.blocks[0].items[0].done=true;after.blocks[0].items.push({id:'new',done:true});after.blocks[1].done=true
 assert.deepEqual(JSON.parse(JSON.stringify(newlyDone(before,after))).map(x=>x.key),['list/a','rem/'])
 assert.equal(newlyDone(after,after).length,0)
 assert.equal(newlyDone(after,before).length,0)
})
