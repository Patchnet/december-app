import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

function harness(reduced=false) {
  const frames=[],animations=[],events={}
  const doc={hidden:false,addEventListener:(name,fn)=>{events[name]=fn}}
  class Node {
    constructor(){this.attrs={};this.children=[];this.dataset={};this.isConnected=true}
    setAttribute(key,value){this.attrs[key]=value}
    append(...nodes){this.children.push(...nodes)}
    cloneNode(){const copy=new Node();copy.attrs={...this.attrs};return copy}
    querySelector(){return this.children.find(c=>c.attrs.class==='wind-thread')}
    getTotalLength(){return 120}
    remove(){this.isConnected=false}
    animate(frames,options){
      const listeners={}
      const animation={options,frames,playState:'running',cancelled:false,
        addEventListener:(name,fn)=>{listeners[name]=fn},
        cancel(){this.cancelled=true;this.playState='idle'},
        pause(){this.playState='paused'},play(){this.playState='running'},
        finish:()=>listeners.finish?.(),
      }
      animations.push(animation);return animation
    }
  }
  doc.createElementNS=()=>new Node()
  const source=readFileSync(new URL('../public/js/working-mark.js',import.meta.url),'utf8').replace(/export \{[^}]+\}/,'')
  const api=runInNewContext(source+'\n;({windMark,unwind,stopWind})',{document:doc,window:{matchMedia:()=>({matches:reduced})},requestAnimationFrame:fn=>frames.push(fn)})
  return {api,frames,animations,doc,events}
}

test('yarn transitions into its loop, pauses when hidden, and releases all animations on removal',()=>{
  const h=harness(),mark=h.api.windMark()
  h.frames.shift()()
  const entrance=h.animations.find(a=>a.options.duration===460)
  entrance.finish()
  assert.equal(entrance.cancelled,true)
  const loop=h.animations.find(a=>a.options.iterations===Infinity)
  assert.ok(loop)
  h.doc.hidden=true;h.events.visibilitychange()
  assert.equal(loop.playState,'paused')
  h.doc.hidden=false;h.events.visibilitychange()
  assert.equal(loop.playState,'running')
  h.api.stopWind(mark)
  assert.ok(h.animations.every(a=>a.cancelled))
  assert.equal(mark.isConnected,false)
})

test('unwind stops the chase and removes the mark; reduced motion is static',()=>{
  const h=harness(),mark=h.api.windMark()
  h.frames.shift()();h.animations.find(a=>a.options.duration===460).finish()
  const loop=h.animations.find(a=>a.options.iterations===Infinity)
  h.api.unwind(mark)
  assert.equal(loop.cancelled,true)
  h.animations.at(-1).finish()
  assert.equal(mark.isConnected,false)
  const quiet=harness(true),still=quiet.api.windMark()
  assert.equal(quiet.frames.length,0)
  assert.equal(quiet.animations.length,0)
  quiet.api.unwind(still)
  assert.equal(still.isConnected,false)
})
