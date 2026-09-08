import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'

function harness({loaded=true,reduced=false,hidden=false}={}) {
  const timers=new Map(),animations=[],events={},classes=new Set(['done'])
  let id=0
  const tick={isConnected:true,children:[],getBoundingClientRect:()=>({width:18,height:18,top:20,left:20,bottom:38,right:38}),appendChild(el){this.children.push(el);el.remove=()=>{this.children=this.children.filter(child=>child!==el)}}}
  const row={querySelector:()=>tick,classList:{contains:name=>classes.has(name),add:name=>classes.add(name),remove:name=>classes.delete(name)}}
  const preference={matches:reduced,addEventListener:(name,fn)=>{events.preference=fn}}
  const document={hidden,documentElement:{classList:{add(){}}},addEventListener:(name,fn)=>{events[name]=fn},createElement:()=>({setAttribute(){},animate(){const animation={cancelled:false,cancel(){this.cancelled=true}};animations.push(animation);return animation}})}
  const source=readFileSync(new URL('../public/js/commit-tick.js',import.meta.url),'utf8').replace(/^export /gm,'').replace('import.meta.url',"'http://localhost/js/commit-tick.js'")
  const api=runInNewContext(source+'\n;({commitTick,clearCommitTick})',{URL,WeakMap,Set,Image:class{decode(){return{then(fn){if(loaded)fn();return{catch(){}}}}}},window:{matchMedia:()=>preference},document,innerHeight:800,innerWidth:1000,setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:id=>timers.delete(id)})
  return {api,row,tick,timers,animations,document,events,preference}
}
test('painted completion replaces a replay and undo releases its plate and timer',()=>{
  const h=harness();h.api.commitTick(h.row);h.api.commitTick(h.row)
  assert.equal(h.tick.children.length,1);assert.equal(h.timers.size,1);assert.ok(h.animations[0].cancelled)
  h.api.clearCommitTick(h.row)
  assert.equal(h.tick.children.length,0);assert.equal(h.timers.size,0);assert.ok(h.animations[1].cancelled)
})
test('completion returns to its static poster without a running animation',()=>{
  const h=harness();h.api.commitTick(h.row);[...h.timers.values()][0]()
  assert.equal(h.tick.children.length,0);assert.ok(h.animations[0].cancelled);assert.equal(h.timers.size,0)
})
test('failed image, reduced motion, hidden and offscreen rows allocate no animation',()=>{
  for(const options of [{loaded:false},{reduced:true},{hidden:true}]){const h=harness(options);h.api.commitTick(h.row);assert.equal(h.animations.length,0)}
  const h=harness();h.tick.getBoundingClientRect=()=>({width:18,height:18,top:900,bottom:918,left:20,right:38});h.api.commitTick(h.row);assert.equal(h.timers.size,0)
})
test('hiding the page or changing motion preference releases active completion accents',()=>{
  const h=harness();h.api.commitTick(h.row);h.document.hidden=true;h.events.visibilitychange();assert.equal(h.tick.children.length,0)
  h.document.hidden=false;h.api.commitTick(h.row);h.preference.matches=true;h.events.preference();assert.equal(h.tick.children.length,0);assert.equal(h.timers.size,0)
})
