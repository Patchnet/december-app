import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { inkLines } from '../public/js/ink-feedback.js'

test('completion ink follows wrapped lines and coalesces nested link fragments',()=>{
  const lines=inkLines([
    {left:20,right:90,top:10,height:18,width:70},
    {left:90,right:130,top:11,height:16,width:40},
    {left:20,right:75,top:34,height:18,width:55},
    {left:20,right:20,top:58,height:18,width:0},
  ],{left:20,top:10})
  assert.equal(lines.length,2)
  assert.equal(lines[0].left,0)
  assert.equal(lines[0].right,110)
  assert.equal(lines[1].right,55)
  assert.ok(lines[1].y>lines[0].y+20)
})

function harness(reduced=false) {
  const timers=new Map(),observers=[]
  let next=0
  function element() {
    const classes=new Set(),children=[]
    return {isConnected:true,firstChild:{},children,
      classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:n=>classes.delete(n),contains:n=>classes.has(n)},
      getBoundingClientRect:()=>({left:10,top:10,right:90,bottom:30,width:80,height:20}),
      querySelector:()=>null,setAttribute(){},appendChild(el){children.push(el);el.remove=()=>children.splice(children.indexOf(el),1)},
    }
  }
  const el=element()
  const context={WeakMap,innerHeight:800,innerWidth:1000,
    window:{matchMedia:()=>({matches:reduced})},
    document:{hidden:false,createElementNS:element,createRange:()=>({selectNode(){},getBoundingClientRect:el.getBoundingClientRect})},
    setTimeout:fn=>{timers.set(++next,fn);return next},clearTimeout:id=>timers.delete(id),
    ResizeObserver:class {constructor(fn){this.callback=fn;observers.push(this)}observe(){}disconnect(){this.disconnected=true}},
  }
  const source=readFileSync(new URL('../public/js/ink-feedback.js',import.meta.url),'utf8').replace(/^export /gm,'')
  const app=runInNewContext(source+'\n;({circleNumber,clearInk})',context)
  return {app,el,timers,observers}
}

test('repeated number updates replace the accent and release timers and observers',()=>{
  const h=harness()
  h.app.circleNumber(h.el)
  h.app.circleNumber(h.el)
  assert.equal(h.el.children.length,1)
  assert.equal(h.timers.size,1)
  assert.equal(h.observers[0].disconnected,true)
  h.app.clearInk(h.el)
  assert.equal(h.el.children.length,0)
  assert.equal(h.timers.size,0)
  assert.equal(h.observers[1].disconnected,true)
})

test('reduced motion and disconnected content allocate no ink or timers',()=>{
  const reduced=harness(true)
  reduced.app.circleNumber(reduced.el)
  assert.equal(reduced.el.children.length,0)
  const h=harness();h.el.isConnected=false
  h.app.circleNumber(h.el)
  assert.equal(h.timers.size,0)
})

test('a resizing target releases its ink instead of leaving a misplaced circle',()=>{
  const h=harness();h.app.circleNumber(h.el)
  h.el.getBoundingClientRect=()=>({width:120,height:20})
  h.observers[0].callback()
  assert.equal(h.el.children.length,0)
  assert.equal(h.timers.size,0)
})
