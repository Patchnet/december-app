import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mediaListMarkup } from '../public/js/list-preview.js'

test('media list disclosure retains every row and has an accurate hidden count', () => {
  const rows = Array.from({length:16},(_,i)=>`<button>Item ${i+1}</button>`)
  const html = mediaListMarkup(rows,'ingredients')
  assert.match(html,/Show 10 more/)
  assert.equal((html.match(/<button>/g)||[]).length,16)
  assert.equal((html.split('<details')[0].match(/<button>/g)||[]).length,6)
  assert.match(mediaListMarkup(rows,'ingredients',true),/data-list-preview="ingredients" open/)
  assert.equal(mediaListMarkup(rows.slice(0,6),'short'),rows.slice(0,6).join(''))
  assert.equal(rows.length,16)
})

test('the real renderer folds only image-backed compact lists and keeps focus complete', async () => {
  const priorWindow = globalThis.window
  globalThis.window = {matchMedia:()=>({matches:true})}
  try {
    const {spaceInner} = await import('../public/js/blocks.js')
    const {page} = await import('../public/js/session.js')
    page.state = {sources:{}}
    const note = {id:'n',type:'note',title:'',text:'A recipe',entities:[]}
    const list = {id:'l',type:'list',title:'Ingredients',items:Array.from({length:16},(_,i)=>({id:`i${i}`,text:`Item ${i}`,done:false})),entities:[]}
    const sp = {id:'s',name:'Dinner',updatedAt:new Date().toISOString(),blocks:[note,list]}
    assert.doesNotMatch(spaceInner(sp),/data-list-preview/,'ordinary lists retain their layout')
    note.preview = {kind:'image',source:'https://example.com/recipe',asset:'a'.repeat(64)+'.jpg'}
    assert.match(spaceInner(sp),/Show 10 more/)
    page.expandedLists.add('l')
    assert.match(spaceInner(sp),/data-list-preview="l" open/)
    const full = spaceInner(sp,true)
    assert.doesNotMatch(full,/data-list-preview/)
    assert.equal((full.match(/role="checkbox"/g)||[]).length,16)
    page.expandedLists.clear()
  } finally {
    if(priorWindow===undefined)delete globalThis.window
    else globalThis.window=priorWindow
  }
})


test('weather uses one condition scene above the heading with forecast text below', async () => {
  const priorWindow = globalThis.window
  globalThis.window = {matchMedia:()=>({matches:true})}
  try {
    const {spaceInner} = await import('../public/js/blocks.js')
    const {page} = await import('../public/js/session.js')
    page.state = {sources:{}}
    const preview = {kind:'weather',source:'https://example.com/weather',status:'ready',code:2,isDay:true,celsius:18,location:'San Francisco',expiresAt:'2099-01-01'}
    const sp = {id:'weather',name:'Outside',updatedAt:new Date().toISOString(),blocks:[{id:'n',type:'note',title:'',text:'Bring a camera.',preview}]}
    for (const full of [false,true]) {
      const html = spaceInner(sp,full)
      assert.equal((html.match(/class="weather-scene"/g)||[]).length,1)
      assert.ok(html.indexOf('class="weather-scene"') < html.indexOf('<h2'))
      assert.ok(html.indexOf('18°C') > html.indexOf('<h2'))
      assert.match(html,/Bring a camera/)
      assert.match(html,/data-sky="partly-cloudy-day"/)
    }
  } finally {
    if(priorWindow===undefined)delete globalThis.window
    else globalThis.window=priorWindow
  }
})

test('card headings omit exact repetition without changing stored titles or hiding distinct sections', async () => {
  const priorWindow=globalThis.window
  globalThis.window={matchMedia:()=>({matches:true})}
  try {
    const {spaceInner}=await import('../public/js/blocks.js')
    const {page}=await import('../public/js/session.js');page.state={sources:{}}
    const list={id:'l',type:'list',title:' groceries ',items:[{id:'i',text:'Apples',done:false}]}
    const space={id:'s',name:'Groceries',blocks:[list]}
    for(const full of [false,true])assert.doesNotMatch(spaceInner(space,full),/class="block-title"/)
    assert.equal(list.title,' groceries ')
    list.title='For dinner';assert.match(spaceInner(space),/For dinner/)
  } finally {globalThis.window=priorWindow}
})

test('completed cards show a receipt and retain an actionable full view', async () => {
  const priorWindow=globalThis.window
  globalThis.window={matchMedia:()=>({matches:true})}
  try {
    const {spaceInner}=await import('../public/js/blocks.js')
    const {page}=await import('../public/js/session.js');page.state={sources:{}}
    const reminder={id:'r',type:'reminder',text:'Dinner with friends',done:true,when:'2026-09-07'}
    const space={id:'s',name:'Dinner',blocks:[reminder]}
    assert.match(spaceInner(space),/Done · Dinner with friends/)
    assert.doesNotMatch(spaceInner(space),/nothing open/)
    assert.match(spaceInner(space,true),/aria-checked="true"/)
    space.blocks=[];assert.match(spaceInner(space),/Nothing here yet/)
  } finally {globalThis.window=priorWindow}
})

test('single-task card text is outside its completion checkbox', async () => {
  const priorWindow=globalThis.window
  globalThis.window={matchMedia:()=>({matches:true})}
  try {
    const {spaceInner}=await import('../public/js/blocks.js')
    const {page}=await import('../public/js/session.js');page.state={sources:{}}
    const html=spaceInner({id:'s',name:'Plumber',blocks:[{id:'r',type:'reminder',text:'Call plumber',when:'2026-09-09',done:false}]})
    const checkbox=html.match(/<button[^>]*solo-check[\s\S]*?<\/button>/)?.[0]
    assert.ok(checkbox);assert.match(checkbox,/data-block="r"/)
    assert.doesNotMatch(checkbox,/class="solo-text"/)
    assert.match(html,/<\/button>\s*<span class="solo-text">Call plumber/)
    assert.doesNotMatch(html,/<button[^>]*class="solo /)
  } finally {globalThis.window=priorWindow}
})

test('a compact card past eight open rows shows six and how many more; the opened card shows all', async () => {
  const priorWindow = globalThis.window
  globalThis.window = {matchMedia:()=>({matches:true})}
  try {
    const {spaceInner} = await import('../public/js/blocks.js')
    const {page} = await import('../public/js/session.js')
    page.state = {sources:{}}
    const list = {id:'l',type:'list',title:'',items:Array.from({length:7},(_,i)=>({id:`i${i}`,text:`Item ${i}`,done:false})),entities:[]}
    const rem = (i) => ({id:`r${i}`,type:'reminder',title:'',text:`Call ${i}`,done:false,when:'2026-10-01',entities:[]})
    const sp = {id:'s',name:'Movers',updatedAt:new Date().toISOString(),blocks:[list,rem(1),rem(2),rem(3)]}
    const compact = spaceInner(sp)
    assert.equal((compact.match(/role="checkbox"/g)||[]).length,6)
    assert.match(compact,/class="fold-more">4 more</)
    const full = spaceInner(sp,true)
    assert.equal((full.match(/role="checkbox"/g)||[]).length,10)
    assert.doesNotMatch(full,/fold-more/)
    // eight rows is not heavy: nothing folds
    const light = {...sp,blocks:[{...list,items:list.items.slice(0,5)},rem(1),rem(2),rem(3)]}
    assert.doesNotMatch(spaceInner(light),/fold-more/)
    assert.equal((spaceInner(light).match(/role="checkbox"/g)||[]).length,8)
  } finally {
    if(priorWindow===undefined)delete globalThis.window
    else globalThis.window=priorWindow
  }
})

test('completed list rows expand in place, preserve disclosure state, and remain intact in full view', async () => {
  const priorWindow = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  try {
    const { spaceInner } = await import('../public/js/blocks.js')
    const { page } = await import('../public/js/session.js')
    page.state = { sources: {} }
    const list = { id: 'completed-list-test', type: 'list', title: 'Groceries', items: [
      { id: 'one', text: 'Bread', done: false },
      { id: 'two', text: 'Milk', done: true, doneAt: '2026-09-19' },
      { id: 'three', text: 'Apples', done: true, doneAt: '2026-09-18' },
    ] }
    const space = { id: 'g', name: 'Groceries', blocks: [list] }
    const original = JSON.stringify(space)
    const compact = spaceInner(space)
    assert.match(compact, /2 completed/)
    assert.match(compact, /data-list-preview="completed:completed-list-test">/)
    assert.equal((compact.match(/role="checkbox"/g) || []).length, 3)
    assert.ok(compact.indexOf('Milk') > compact.indexOf('<details'))
    page.expandedLists.add('completed:completed-list-test')
    assert.match(spaceInner(space), /data-list-preview="completed:completed-list-test" open/)
    const full = spaceInner(space, true)
    assert.doesNotMatch(full, /class="list-preview completed-list"/)
    assert.equal((full.match(/role="checkbox"/g) || []).length, 3)
    assert.equal(JSON.stringify(space), original)
    page.expandedLists.delete('completed:completed-list-test')
  } finally { globalThis.window = priorWindow }
})
