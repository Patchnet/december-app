import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const layout = read('public/js/layout.js')
const strip = read('public/js/attention.js')
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

test('the stage says the shape of the day: one next thing and counts, never a list of tasks', () => {
  const render = functionBody(strip, 'renderToday', 'maybeNotify')
  // nothing is measured against a floor and dropped, which is how a heavy
  // day once painted as nothing; nothing here is a task to tick either
  assert.doesNotMatch(render, /getBoundingClientRect|overflows\(\)/)
  assert.doesNotMatch(render, /class="tick"/)
  // overdue is a count, never the next thing
  assert.match(render, /const next = dueToday\[0\] \|\| week\[0\] \|\| surfaced\[0\]/)
  assert.match(render, /\$\{late\} overdue<\/button>/)
  // every count is a real control into the full sheet
  assert.match(render, /class="shape-part overdue" data-attention-open aria-haspopup="dialog" aria-controls="focus"/)
  assert.match(render, /data-history-open aria-haspopup="dialog"/)
  assert.match(pageCss, /\.shape-part:focus-visible[^}]*var\(--focus-ring-field\)/)
  // the stage no longer has a fixed height for anything to overflow
  assert.doesNotMatch(pageCss, /--goals-h/)
})

test('attention keeps independent reminder identities instead of collapsing equal text', () => {
  const render = functionBody(strip, 'renderToday', 'maybeNotify')
  assert.match(render, /byKey.set\(reminderIdentity\(s,b\),\{s,b\}\)/)
  assert.doesNotMatch(render, /b\.text\.trim\(\)\.toLowerCase\(\)/)
  assert.match(render, /localDayAfter\(7\)/)
})

test('every row is one line in one grammar: the thing on the left, the card and the day on the right', () => {
  assert.match(strip, /function placeWords\(space, label, \.\.\.rest\)/)
  assert.match(strip, /sub: placeWords\(s\.name, b\.text, day, b\.repeat\)/)
  // the engine's reason is a sentence: it rides as the row's title, not in the line
  assert.match(strip, /sub: placeWords\(space, su\.label\), why: shortReason\(su\.reason\)/)
  assert.match(strip, /title="\$\{esc\(i\.why\)\}"/)
  // overdue is a mark, not a colored word
  assert.match(pageCss, /\.today-sub\.overdue::before \{[^}]*background: var\(--bad-ink\)/)
  assert.match(pageCss, /\.today-row \.row-text \{[^}]*text-overflow: ellipsis/)
})

test('attention expansion contains every current row with the same actions', () => {
  const open = functionBody(strip, 'openAttention', 'renderToday')
  assert.match(open, /attentionItems\.filter\(\(i\) => i\.kind !== 'ahead'\)/)
  assert.match(open, /attentionItems\.filter\(\(i\) => i\.kind === 'ahead'\)/)
  assert.match(open, /attentionBand\('today', now\)/)
  assert.match(open, /attentionBand\('this week', week\)/)
  assert.match(strip, /\$\{attentionRow\(i\)\}/)
  assert.match(strip, /#focus \.attention-list \.today-row/)
  assert.match(strip, /const keyboardCheck = row\?\.matches\('\.row\[data-block\]'\) && e\.detail === 0/)
  assert.match(strip, /if \(!row \|\| e\.target\.closest\('\.tick'\) \|\| keyboardCheck\) return/)
  assert.match(strip, /closeFocus\(\)[\s\S]*?hooks\.jumpToSpace\(sid\)/)
  assert.match(focusTask, /row\.closest\('\.attention-card'\)/)
})

test('attention dialog has a named close path and restores focus', () => {
  const open = functionBody(strip, 'openAttention', 'renderToday')
  const close = functionBody(layout, 'closeFocus', 'renderYearline')
  assert.match(open, /role="dialog" aria-modal="true" aria-labelledby="attention-title"/)
  assert.match(open, /data-close data-attention-close>Close and return<\/button>/)
  assert.match(open, /rememberReturn\(\)/)
  assert.match(open, /querySelector\('\[data-attention-close\]'\)\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(close, /if \(returnTo\)[\s\S]*?returnTo\.isConnected/)
  assert.match(close, /querySelector\('\[data-attention-open\]'\) \|\| page\.field/)
  assert.match(close, /focus\?\.\(\{ preventScroll: true \}\)/)
  assert.match(strip, /e\.key !== 'Tab' \|\| !card/)
  assert.match(strip, /card\.querySelectorAll\('button:not\(\[disabled\]\)'\)/)
  assert.match(actions, /e\.key === 'Escape'[\s\S]*?closeFocus\(\)/)
})

test('month detail labels overdue work in text and never as a background highlight', () => {
  // the journal's spreads say it in words, in the label column
  assert.match(year, /overdue \? `<span class="overdue">\$\{overdue\} overdue<\/span>`/)
  assert.match(year, /ahead \? `\$\{ahead\} scheduled`/)
  assert.match(year, /<span class="w od">overdue<\/span>/)
  assert.match(year, /l\.overdue \? ' overdue' : ''/)
  assert.match(year, /<span class="mo-status">overdue<\/span>/)
  assert.match(year, /m\.overdue \? `\$\{m\.overdue\} overdue`/)
  assert.match(year, /m\.ahead \? `\$\{m\.ahead\} scheduled`/)
  assert.match(yearCss, /\.mo-line\.overdue \.mo-text \{ color: var\(--text-2\)/)
  const overdueRule = yearCss.match(/\.mo-line\.overdue \.mo-day,[\s\S]*?\}/)?.[0] || ''
  assert.doesNotMatch(overdueRule, /background/)
})
