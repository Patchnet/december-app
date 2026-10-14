import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

test('a pending clarification exclusively owns the stage, then restores working feedback',()=>{
  const classes=()=>{const values=new Set();return {contains:x=>values.has(x),toggle:(x,on)=>on?values.add(x):values.delete(x)}}
  const panes=Object.fromEntries(['ask','settling','idle'].map(name=>[name,{classList:classes(),inert:false}]))
  const moment={};panes.settling.parentElement=moment
  const stage={dataset:{},classList:classes(),querySelector:s=>s==='.moment'?moment:s==='.stage-foot'?null:panes[s.replace('.pane-','')]}
  const page={field:{value:''},state:{ask:{id:'question'},captures:[{id:'pending'}],settle:{running:false}},queuedTexts:[],flying:0}
  const source=readFileSync(new URL('../public/js/paint.js',import.meta.url),'utf8')
  const code=source.slice(source.indexOf('export function renderStage'),source.indexOf("import { measureCapturePaint")).replace('export ','')
  const render=runInNewContext(code+';renderStage',{$:()=>stage,page,hooks:{fitCapture(){}},localStorage:{getItem:()=> '6'}})
  for(const running of [false,true]){
    page.state.settle.running=running;render()
    assert.equal(stage.dataset.mode,'asking')
    assert.equal(panes.ask.inert,false)
    assert.equal(panes.settling.inert,true)
    assert.equal(panes.settling.classList.contains('off'),true)
    assert.equal(panes.idle.inert,true)
  }
  page.state.ask=null;render()
  assert.equal(stage.dataset.mode,'settling')
  assert.equal(panes.settling.inert,false)
  assert.equal(panes.ask.inert,true)
})
