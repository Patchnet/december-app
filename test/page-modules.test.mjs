// Page module layout — native ES modules, no bundler, landing caps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public')
const jsDir = join(publicDir, 'js')

const jsFiles = () => [
  join(publicDir, 'app.js'),
  ...readdirSync(jsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(jsDir, f)),
]

const read = (abs) => readFileSync(abs, 'utf8')
const lineCount = (abs) => read(abs).split(/\r?\n/).length

test('every page module parses', () => {
  for (const file of jsFiles()) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${file}: ${r.stderr}`)
  }
})

test('goal page helpers trust server stamps and degrade safely', async () => {
  const priorWindow = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  try {
    const { paceWords, goalLabel, goalClass, quietWords } = await import('../public/js/goals.js?stamp-test')
    assert.equal(paceWords({ paceText: '0.5 behind' }), '0.5 behind')
    assert.equal(paceWords({ paceText: 'not a pace', met: false }), 'pace unavailable')
    assert.equal(paceWords({}), 'pace unavailable')
    assert.equal(paceWords({ met: true }), 'done')
    assert.equal(goalClass({ behind: true }), 'behind')
    assert.equal(goalClass({ behind: 'true' }), '')
    assert.equal(goalClass({ met: true, behind: true }), 'met')
    assert.equal(quietWords({ quietText: 'quiet 14 days' }), 'quiet 14 days')
    assert.equal(quietWords({ quietText: 'quiet soon' }), '')
    assert.equal(quietWords({}), '')
    assert.equal(goalLabel({ name: 'Running' }, { title: 'Runs', goal: { label: 'Running' } }), 'Running')
    assert.equal(goalLabel({ name: 'Running' }, { title: 'Runs', goal: { label: 7 } }), 'Runs')
    assert.equal(goalLabel({}, { goal: {} }), 'Goal')
  } finally {
    if (priorWindow === undefined) delete globalThis.window
    else globalThis.window = priorWindow
  }
})

test('goal page modules do not rederive server pace or counted-list rules', () => {
  const goals = read(join(jsDir, 'goals.js'))
  const year = read(join(jsDir, 'year.js'))
  const actions = read(join(jsDir, 'actions.js'))
  assert.doesNotMatch(goals, /\.diff\b|Date\.now\(\)/)
  assert.doesNotMatch(year, /\.diff\b/)
  assert.doesNotMatch(actions, /function trackerCounting\b/)
  assert.match(actions, /typeof listBlock\?\.countedBy === 'string'/)
})

test('runtime-only page names stay imported and page-scoped', () => {
  const actions = read(join(jsDir, 'actions.js'))
  const motionImport = actions.match(/import \{([^}]+)\} from '\.\/motion\.js'/)?.[1] || ''
  assert.match(motionImport, /\bmarkEdited\b/, 'actions imports markEdited')
  assert.match(motionImport, /\bbump\b/, 'actions imports bump')

  const year = read(join(jsDir, 'year.js'))
  const coCommit = year.match(/async function coCommit\(\) \{[\s\S]*?(?=\n\})/)?.[0] || ''
  assert.match(coCommit, /page\.coAnswered\.entries\(\)/, 'coCommit reads answers from the page context')
  assert.doesNotMatch(coCommit, /(?<![.\w])coAnswered\.entries\(\)/, 'coCommit has no bare coAnswered reference')
})

test('lint rejects undefined and unused page names', () => {
  const eslint = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js')
  assert.ok(existsSync(eslint), 'ESLint is required; run npm ci before the test suite')
  const result = spawnSync(
    process.execPath,
    [eslint, '--stdin', '--stdin-filename', 'public/js/lint-regression.js'],
    {
      cwd: root,
      encoding: 'utf8',
      input: 'markEdited(document.body)\nconst coAnswered = new Map()\n',
    }
  )
  const output = `${result.stdout}${result.stderr}`
  assert.equal(result.status, 1, output)
  assert.match(output, /markEdited.*no-undef/s)
  assert.match(output, /coAnswered.*no-unused-vars/s)
})

test('app.js stays the boot file', () => {
  const src = read(join(publicDir, 'app.js'))
  const n = lineCount(join(publicDir, 'app.js'))
  assert.ok(n < 120, `app.js is ${n} lines`)
  assert.match(src, /from '\.\/js\/session\.js'/)
  assert.match(src, /new surface gets a new file/)
})

test('styles.css only assembles sheets', () => {
  const src = read(join(publicDir, 'styles.css'))
  assert.ok(src.split(/\r?\n/).length < 20)
  for (const sheet of ['tokens', 'page', 'cards', 'year', 'settings']) {
    assert.match(src, new RegExp(`@import url\\('\\./css/${sheet}\\.css'\\)`))
    assert.ok(readdirSync(join(publicDir, 'css')).includes(`${sheet}.css`))
  }
})

test('page modules stay under the landing cap', () => {
  for (const f of readdirSync(jsDir).filter((n) => n.endsWith('.js'))) {
    const n = lineCount(join(jsDir, f))
    assert.ok(n < 900, `${f} is ${n} lines — new surface work belongs in a new file`)
  }
})

test('session names are not double-qualified', () => {
  for (const file of jsFiles()) {
    const src = read(file)
    assert.doesNotMatch(src, /page\.page\./, file)
    assert.doesNotMatch(src, /hooks\.hooks\./, file)
    assert.doesNotMatch(src, /status\.page\.state/, file)
    assert.doesNotMatch(src, /out\.page\.state/, file)
  }
})

test('layout keeps render state on the page context', () => {
  const src = read(join(jsDir, 'layout.js'))
  const renderInbox = src.match(/function renderInbox\b[\s\S]*?(?=\nfunction renderActivity\b)/)?.[0]
  assert.ok(renderInbox, 'renderInbox is present')
  assert.doesNotMatch(renderInbox, /(^|[^.\w])pending\b/m)
  assert.doesNotMatch(renderInbox, /(^|[^.\w])queuedTexts\b/m)
  assert.doesNotMatch(renderInbox, /(^|[^.\w])state\./m)
})

test('page modules have no import cycles', () => {
  const graph = new Map()
  const add = (file, src, fromDir) => {
    const deps = [...src.matchAll(/(?:from|import)\s+['"](\.\/[^'"]+)['"]/g)].map((m) => {
      const spec = m[1]
      if (spec.startsWith('./js/')) return spec.slice('./js/'.length)
      if (fromDir === 'js') return spec.slice(2)
      return spec
    })
    graph.set(file, deps)
  }
  add('app.js', read(join(publicDir, 'app.js')), 'public')
  for (const f of readdirSync(jsDir).filter((n) => n.endsWith('.js'))) {
    add(f, read(join(jsDir, f)), 'js')
  }
  const visit = (node, stack) => {
    if (stack.includes(node)) assert.fail(`cycle: ${[...stack, node].join(' → ')}`)
    for (const dep of graph.get(node) || []) visit(dep, [...stack, node])
  }
  for (const node of graph.keys()) visit(node, [])
})

test('no page module references a bare `state.` (use page.state)', () => {
  // The refactor moved shared state onto `page`. A leftover bare `state.foo`
  // is a ReferenceError that only fires once real content renders — invisible
  // on an empty page, fatal on a populated one. Guard the whole family.
  const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'))
  for (const f of files) {
    const src = read(join(jsDir, f))
    for (const [i, line] of src.split(/\r?\n/).entries()) {
      const code = line.replace(/\/\/.*$/, '')
      const bad = /(^|[^.\w])state\.(sources|spaces|captures|settle|activity|year|ask|suggestions|surfaced|lessons|canUndo|carryover|pocket)\b/.exec(code)
      assert.ok(!bad, `${f}:${i + 1} references bare \`state.\` — use \`page.state.\``)
    }
  }
})
