import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function harness(lineEnding='\n') {
  const listeners = new Map()
  const results = {innerHTML:'',classList:{add(){},remove(){}},querySelector(){return null},addEventListener(){}}
  const field = {value:'',addEventListener(name,fn){listeners.set(name,fn)}}
  let resolve
  const context = {
    $: selector => selector === '#search' ? field : results,
    esc: String, hooks: {}, page:{state:{spaces:[]}},
    document:{addEventListener(){}},
    api: () => new Promise(done=>{resolve=done}),
  }
  const source = readFileSync(new URL('../public/js/search.js',import.meta.url),'utf8').replace(/\r?\n/g,lineEnding).replace(/^import[^\r\n]*\r?\n/,'')
  const app = runInNewContext(source+'\n;({askThePage,closeSearch})',context)
  return {app,results,field,listeners,resolve:value=>resolve(value)}
}

for(const lineEnding of ['\n','\r\n']) {
test(`a closed search cannot be repopulated by a late answer (${lineEnding.length===1?'LF':'CRLF'})`, async () => {
  const h = harness(lineEnding)
  const pending = h.app.askThePage('What did I save?')
  h.app.closeSearch()
  h.resolve({answer:'Old answer'})
  await pending
  assert.equal(h.results.innerHTML,'')
})

test(`new local search results take precedence over an earlier question (${lineEnding.length===1?'LF':'CRLF'})`, async () => {
  const h = harness(lineEnding)
  const pending = h.app.askThePage('What did I save?')
  h.field.value = 'pasta'
  h.listeners.get('input')()
  const local = h.results.innerHTML
  h.resolve({answer:'Old answer'})
  await pending
  assert.equal(h.results.innerHTML,local)
  assert.match(local,/No matches/)
})

}
