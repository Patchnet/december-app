import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const layout = read('public/js/layout.js')
const actions = read('public/js/actions.js')
const focusTask = read('public/js/focus-task.js')
const pageCss = read('public/css/page.css')
const year = read('public/js/year.js')
const yearCss = read('public/css/year.css')

const functionBody = (source, name, next) => {
  const match = source.match(new RegExp(`function ${name}\\b[\\s\\S]*?(?=\\n(?:function|const) ${next}\\b)`))
  assert.ok(match, `${name} is present`)
  return match[0]
}

test('compact attention still pixel-fits and exposes hidden rows with a real control', () => {
  const render = functionBody(layout, 'renderToday', 'CAN_DO')
  assert.match(render, /getBoundingClientRect\(\)\.bottom/)
  assert.match(render, /while \(overflows\(\)/)
  assert.match(layout, /<button class="today-more" data-attention-open/)
  assert.match(layout, /aria-haspopup="dialog" aria-controls="focus"/)
  assert.match(layout, />View \$\{hidden\} more<\/button>/)
  assert.doesNotMatch(layout, /<span class="today-more">|\+\$\{left\} more/)
  assert.match(pageCss, /\.today-more:focus-visible[^}]*var\(--focus-ring-field\)/)
})

test('attention expansion contains every current row with the same actions', () => {
  const open = functionBody(layout, 'openAttention', 'renderToday')
  assert.match(open, /attentionItems\.filter\(\(i\) => i\.kind !== 'ahead'\)/)
  assert.match(open, /attentionItems\.filter\(\(i\) => i\.kind === 'ahead'\)/)
  assert.match(open, /attentionBand\('today', now\)/)
  assert.match(open, /attentionBand\('this week', week\)/)
  assert.match(layout, /\$\{attentionRow\(i\)\}/)
  assert.match(layout, /#focus \.attention-list \.today-row/)
  assert.match(layout, /const keyboardCheck = row\?\.matches\('\.row\[data-block\]'\) && e\.detail === 0/)
  assert.match(layout, /if \(!row \|\| e\.target\.closest\('\.tick'\) \|\| keyboardCheck\) return/)
  assert.match(layout, /closeFocus\(\)[\s\S]*?hooks\.jumpToSpace\(sid\)/)
  assert.match(focusTask, /row\.closest\('\.attention-card'\)/)
})

test('attention dialog has a named close path and restores focus', () => {
  const open = functionBody(layout, 'openAttention', 'renderToday')
  const close = functionBody(layout, 'closeFocus', 'renderYearline')
  assert.match(open, /role="dialog" aria-modal="true" aria-labelledby="attention-title"/)
  assert.match(open, /data-close data-attention-close>Close and return<\/button>/)
  assert.match(open, /attentionReturn = document\.activeElement/)
  assert.match(open, /querySelector\('\[data-attention-close\]'\)\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(close, /if \(returnTo\)[\s\S]*?returnTo\.isConnected/)
  assert.match(close, /querySelector\('\[data-attention-open\]'\) \|\| page\.field/)
  assert.match(close, /focus\?\.\(\{ preventScroll: true \}\)/)
  assert.match(layout, /e\.key !== 'Tab' \|\| !card/)
  assert.match(layout, /card\.querySelectorAll\('button:not\(\[disabled\]\)'\)/)
  assert.match(actions, /e\.key === 'Escape'[\s\S]*?closeFocus\(\)/)
})

test('month detail labels overdue work in text and never as a background highlight', () => {
  assert.match(year, /data\.overdue\} overdue/)
  assert.match(year, /data\.scheduled\} scheduled/)
  assert.match(year, /l\.overdue \? ' overdue' : ''/)
  assert.match(year, /<span class="mo-status">overdue<\/span>/)
  assert.match(year, /m\.overdue \? `\$\{m\.overdue\} overdue`/)
  assert.match(year, /m\.ahead \? `\$\{m\.ahead\} scheduled`/)
  assert.match(yearCss, /\.mo-line\.overdue \.mo-text \{ color: var\(--text-2\)/)
  const overdueRule = yearCss.match(/\.mo-line\.overdue \.mo-day,[\s\S]*?\}/)?.[0] || ''
  assert.doesNotMatch(overdueRule, /background/)
})
