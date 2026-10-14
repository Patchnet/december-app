import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function shapeHarness() {
  const callbacks = {}, frames = new Map()
  let now = 0, id = 0
  const preference = { matches: false, addEventListener: (_, cb) => { callbacks.preference = cb } }
  const document = { hidden: false, addEventListener: (name, cb) => { callbacks[name] = cb } }
  const source = readFileSync(new URL('../public/js/card-shape.js', import.meta.url), 'utf8').replaceAll('export function', 'function')
  const app = runInNewContext(source + ';({animateCardShape,restHeight})', {
    window: { matchMedia: () => preference, addEventListener: (name, cb) => { callbacks[name] = cb } }, document,
    performance: {now:()=>now}, requestAnimationFrame: cb => { frames.set(++id,cb);return id }, cancelAnimationFrame: key=>frames.delete(key),
    getComputedStyle: () => ({paddingTop:'12px',paddingBottom:'12px',marginBottom:'8px',opacity:'1'}),
  })
  const style = {height:'',paddingTop:'',paddingBottom:'',marginBottom:'',opacity:''}
  const el = {isConnected:true,style,natural:240,get offsetHeight(){return parseFloat(style.height)||this.natural},getBoundingClientRect(){return {height:this.offsetHeight}}}
  const step = () => { now+=16;const pending=[...frames.values()];frames.clear();for(const cb of pending)cb(now) }
  return {animate:app.animateCardShape,rest:app.restHeight,el,frames,step,callbacks,preference,document}
}

test('growth preserves displayed height across retargeting and returns to natural layout', () => {
  const h=shapeHarness()
  h.animate(h.el,100);h.step();h.step()
  const visible=h.el.style.height
  h.el.natural=310;h.animate(h.el,parseFloat(visible))
  assert.equal(h.el.style.height,visible)
  assert.equal(h.rest(h.el),310)
  let previous=parseFloat(visible)
  for(let i=0;i<120 && h.frames.size;i++) {h.step();const height=h.el.offsetHeight;assert.ok(height>=previous-.2);assert.ok(height<=310.2);previous=height}
  assert.equal(h.frames.size,0)
  assert.equal(h.el.style.height,'')
})

test('resize retargets; reduced motion, backgrounding and disconnection release sizing', () => {
  for(const trigger of ['resize','visibilitychange','preference','disconnected']) {
    const h=shapeHarness();h.animate(h.el,100);h.step()
    if(trigger==='resize'){h.el.natural=320;h.callbacks.resize();h.step();assert.equal(h.rest(h.el),320)}
    if(trigger==='visibilitychange'){h.document.hidden=true;h.callbacks.visibilitychange()}
    if(trigger==='preference'){h.preference.matches=true;h.callbacks.preference()}
    if(trigger==='disconnected'){h.el.isConnected=false;h.step()}
    for(let i=0;i<120 && h.frames.size;i++)h.step()
    assert.equal(h.frames.size,0);assert.equal(h.el.style.height,'')
  }
})

test('filing keeps provisional ink until the blue dot lands, then resolves it once', () => {
  const source = readFileSync(new URL('../public/js/layout.js', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('function landRun('), source.indexOf('/** Keep the existing thought'))
  const events = [], scheduled = []
  const target = { classList: { contains: () => false } }
  const box = { querySelector: () => ({ getBoundingClientRect: () => ({}) }) }
  const page = { pending: new Set(['done']), spaceEls: new Map([['space', { el: target }]]), flying: 0, state: { captures: [], settle: {} } }
  let land
  const render = runInNewContext(fn + ';landRun', {
    run: {dests:new Set(['space']),revealed:new Set()}, landing:new Map(),released:[],
    resolveCards:()=>{target._filing=false;events.push('ink','swipe')},renderInbox:()=>{},releaseHeld:()=>{},
    page, $: () => box, document: { hidden: false }, window: { matchMedia: () => ({ matches: false }) },
    filingPlan: candidates => candidates.map(target => ({ target, delay: 0 })),
    unbuild: () => events.push('ink'), washCard: () => events.push('swipe'),
    travelDot: (origin, el, callback) => { land = callback },
    hooks: { render: () => {} },
    setTimeout: cb => scheduled.push(cb), pendingView: () => ({}), renderPendingStage: () => {},
  })
  render(box)
  assert.deepEqual(events, [], 'saved content stays provisional during flight')
  assert.equal(target._filing, true)
  scheduled.shift()()
  assert.equal(page.flying, 1)
  land(); land()
  assert.deepEqual(events, ['ink', 'swipe'])
  assert.equal(page.flying, 0)
  assert.equal(target._filing, false)
})

test('later polls cannot release a card while its dot is in flight', () => {
  const source = readFileSync(new URL('../public/js/layout.js', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('function releaseHeld('), source.indexOf('/** Keep the existing thought'))
  const landed = [], flying = { dataset: { sid: 'a' }, _filing: true }, idle = { dataset: { sid: 'b' } }
  const release = runInNewContext(fn + ';releaseHeld', {
    released:[],heldNow:()=>new Set(),
    page: { state: { captures: [], settle: {} } }, document: { querySelectorAll: () => [flying, idle] }, unbuild: el => landed.push(el),
  })
  release(new Map())
  assert.deepEqual(landed, [idle])
})

test('interrupted flights settle exactly once and release their animations', () => {
  const source = readFileSync(new URL('../public/js/motion.js', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('function travelDot('), source.indexOf('/** Where the mote lands'))
  for (const reason of ['finish', 'cancel', 'hidden', 'preference', 'timeout']) {
    let landed = 0, fallback
    const animations = [], listeners = {}
    const preference = { matches: false, addEventListener: (_, cb) => { listeners.preference = cb }, removeEventListener() {} }
    const document = { hidden: false, body: { appendChild() {} },
      addEventListener: (_, cb) => { listeners.visibility = cb }, removeEventListener() {},
      createElement: () => ({ style: {}, remove() {}, animate() {
        const callbacks = {}
        const animation = { cancelled: false, addEventListener: (name, cb) => { (callbacks[name] ||= []).push(cb) },
          cancel() { this.cancelled = true; for (const cb of callbacks.cancel || []) cb() },
          finish() { for (const cb of callbacks.finish || []) cb() },
        }
        animations.push(animation)
        return animation
      } }),
    }
    const travel = runInNewContext(fn + ';travelDot', {
      document, reduced: false, inViewport: () => true, bloom: () => {},
      window: { matchMedia: () => preference }, setTimeout: cb => { fallback = cb }, clearTimeout() {},
    })
    travel({ left: 10, top: 20, height: 10 }, { isConnected: true, getBoundingClientRect: () => ({left:100,top:200}) }, () => landed++)
    if (reason === 'finish') animations[1].finish()
    if (reason === 'cancel') animations[1].cancel()
    if (reason === 'hidden') { document.hidden = true; listeners.visibility() }
    if (reason === 'preference') { preference.matches = true; listeners.preference() }
    if (reason === 'timeout') fallback()
    animations[1].finish()
    fallback()
    assert.equal(landed, 1, reason)
    assert.ok(animations.every(a => a.cancelled), reason)
  }
})
