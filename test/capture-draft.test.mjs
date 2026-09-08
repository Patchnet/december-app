import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

function harness() {
  let resolve,reject,submitted,delivered=0,focused
  const retained=new Promise((yes,no)=>{resolve=yes;reject=no})
  const classes={remove(){}}
  const field={value:'first note',style:{},offsetHeight:20,closest:()=>({classList:classes,dataset:{}})}
  const page={field,enterHint:{classList:classes},state:{spaces:[{id:'a',name:'Work'},{id:'b',name:'Home'}]},focusId:'a'}
  const errors=[]
  const context={page,retainSubmission:(...args)=>{submitted=args;return retained},deliverCaptures:()=>{delivered++},document:{documentElement:{style:{setProperty(){}}},addEventListener:(_,fn)=>{focused=fn}},$:()=>({classList:classes}),nextPrompt(){},localStorage:{getItem(){},setItem(){}},window:{},hooks:{render(){}},toast:message=>errors.push(message)}
  const source=readFileSync(new URL('../public/js/capture.js',import.meta.url),'utf8')
  const main=source.slice(source.indexOf('let retainingMain'),source.indexOf('// The page greets'))
  const focus=source.slice(source.indexOf('const retainingFields'),source.indexOf('// the page opens quiet'))
  const submit=runInNewContext(main+'\n'+focus+'\nsubmitCapture',context)
  return {page,field,errors,resolve,reject,submit,focus:()=>focused({target:{closest:()=>field},key:'Enter',preventDefault(){}}),get submitted(){return submitted},get delivered(){return delivered}}
}

test('main capture preserves a newer draft while the submitted note is retained',async()=>{
  const h=harness(),saving=h.submit()
  assert.equal(h.field.value,'first note')
  h.field.value='second note';h.resolve();await saving
  assert.equal(h.field.value,'second note');assert.equal(h.delivered,1)
  assert.deepEqual(h.submitted,['first note'])
})
test('failed local retention leaves the original main draft available',async()=>{
  const h=harness(),saving=h.submit()
  h.reject(new Error('disk quota'));await saving
  assert.equal(h.field.value,'first note');assert.equal(h.delivered,0)
  assert.deepEqual(h.errors,['disk quota'])
})
test('focused capture keeps its submitted destination and a newer draft',async()=>{
  const h=harness(),saving=h.focus()
  h.page.focusId='b';h.field.value='second note';h.resolve();await saving
  assert.deepEqual(h.submitted,['first note','Work'])
  assert.equal(h.field.value,'second note');assert.equal(h.delivered,1)
})
test('failed focused retention preserves the field and permits another submission',async()=>{
  const h=harness(),saving=h.focus()
  h.reject(new Error('disk quota'));await saving
  assert.equal(h.field.value,'first note');assert.equal(h.delivered,0)
  await h.focus();assert.equal(h.errors.length,2)
})
