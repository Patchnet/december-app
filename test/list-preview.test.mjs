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
    assert.match(spaceInner(space),/Completed · Dinner with friends/)
    assert.doesNotMatch(spaceInner(space),/nothing open/)
    assert.match(spaceInner(space,true),/aria-checked="true"/)
    space.blocks=[];assert.match(spaceInner(space),/No items yet/)
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
