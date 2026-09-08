import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { weekCaret } from '../public/js/year-week-caret.js'
import { beginYearRequest, invalidateYearRequest, currentYearRequest, yearPosition } from '../public/js/year-navigation.js'

function harness() {
  const pending = [], painted = [], errors = []
  const wrap = {querySelector:()=>null,setAttribute(){},removeAttribute(){}}
  const page = {state:{year:{year:2026,month:8,months:Array.from({length:12},()=>({events:0})),weeks:[]},archivedYears:[]}}
  const context = {
    $:()=>wrap, esc:String, page, hooks:{}, document:{addEventListener(){}},
    beginYearRequest, invalidateYearRequest, currentYearRequest, yearPosition, weekCaret,
    showYearSurface:(wrap,html)=>painted.push(html),mountSurface(){},
    liveGoals:()=>[],toast:message=>errors.push(message),
    api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),
  }
  const source = readFileSync(new URL('../public/js/year.js',import.meta.url),'utf8')
    .replace(/^import .*$/gm,'').replace(/export \{[\s\S]*?\}\s*$/,'')
  const app = runInNewContext(source+'\n;({buildYear,openMonth,openPastYear})',context)
  return {app,page,pending,painted,errors}
}
const month = (month,label='A month')=>({month,label,weeks:[],spaces:[],total:0,ahead:0,overdue:0})

test('calendar progress handles leap years and never shows negative remaining days',()=>{
  assert.equal(yearPosition(2024,new Date(2024,0,1)).daysLeft,366)
  assert.equal(yearPosition(2026,new Date(2026,11,12)).daysToDecember,0)
  assert.equal(yearPosition(2025,new Date(2026,0,2)).through,1)
  assert.equal(yearPosition(2025,new Date(2026,0,2)).daysLeft,0)
  assert.equal(yearPosition(2027,new Date(2026,0,1)).through,0)
})

test('all twelve months are openable even when empty, including the archive',()=>{
  const h=harness()
  h.app.buildYear()
  assert.equal((h.painted[0].match(/<button class="yr-mo /g)||[]).length,12)
  assert.match(h.painted[0],/data-month="2026-12"/)
  assert.match(h.painted[0],/aria-current="date"/)
  h.page.yearShown={...h.page.state.year,year:2025}
  h.app.buildYear()
  assert.equal((h.painted[1].match(/<button class="yr-mo /g)||[]).length,12)
  assert.match(h.painted[1],/href="\/api\/export\/2025.md"/)
  assert.doesNotMatch(h.painted[1],/aria-current="date"/)
})

test('the latest month navigation wins when responses arrive out of order',async()=>{
  const h=harness()
  const first=h.app.openMonth('2026-08'),second=h.app.openMonth('2026-09')
  h.pending[1].resolve(month('2026-09','September 2026')); await second
  h.pending[0].resolve(month('2026-08','August 2026')); await first
  assert.equal(h.page.monthShown,'2026-09')
  assert.equal(h.painted.length,1)
})

test('closing a year navigation prevents a late response from reopening it',async()=>{
  const h=harness(), request=h.app.openMonth('2026-10')
  invalidateYearRequest()
  h.pending[0].resolve(month('2026-10')); await request
  assert.equal(h.painted.length,0)
  assert.equal(h.page.monthShown,undefined)
})

test('returning to the year invalidates a month request still in flight',async()=>{
  const h=harness(), request=h.app.openMonth('2026-10')
  h.app.buildYear()
  h.pending[0].resolve(month('2026-10')); await request
  assert.equal(h.page.monthShown,null)
  assert.equal(h.painted.length,1)
  assert.match(h.painted[0],/class="focus-card year-card"/)
})

test('a dismissed archive request does not show a stale error',async()=>{
  const h=harness(), request=h.app.openPastYear(2025)
  invalidateYearRequest()
  h.pending[0].reject(new Error('Archive unavailable')); await request
  assert.equal(h.errors.length,0)
})


test('the drawn marker belongs to the current week and plays only on entering the current year',()=>{
  const h=harness()
  h.page.state.year.year=new Date().getFullYear()
  h.page.state.year.weeks=Array(53).fill(0)
  h.app.buildYear()
  assert.equal((h.painted[0].match(/class="yr-week-caret"/g)||[]).length,1)
  assert.match(h.painted[0],/class="w wnow"><svg class="yr-week-caret"/)
  h.page.monthShown=`${h.page.state.year.year}-09`
  h.app.buildYear()
  assert.doesNotMatch(h.painted[1],/class="yr-week-caret"/)
  h.page.yearShown={...h.page.state.year,year:h.page.state.year.year-1}
  h.app.buildYear()
  assert.doesNotMatch(h.painted[2],/class="yr-week-caret"/)
})
