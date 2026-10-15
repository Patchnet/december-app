// Board facts: what git says about a branch, placed under the cards' scopes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scopeMatcher, placeFiles, createBoardFacts } from '../lib/board-facts.mjs'

const temp = (name) => realpathSync.native(mkdtempSync(join(tmpdir(), `december-facts-${name}-`)))
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { cwd, encoding: 'utf8' }).trim()
const write = (root, path, text = 'x\n') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }

test('a scope glob stays in its folder with *, crosses folders with **, and a bare folder covers its tree', () => {
  const m = scopeMatcher(['lib/board-*.mjs', 'public/css/', '**/*.test.mjs', 'README.md'])
  assert.ok(m('lib/board-facts.mjs'))
  assert.ok(!m('lib/sub/board-facts.mjs'), '* never crosses a folder')
  assert.ok(m('public/css/board.css') && m('public/css/deep/x.css'))
  assert.ok(m('test/board.test.mjs') && m('a/b/c.test.mjs') && m('x.test.mjs'))
  assert.ok(m('README.md') && !m('docs/README.md'))
  assert.ok(!scopeMatcher([])('anything'))
})

test('files sit under the card whose scope covers them; drift exists only once a card has bounds', () => {
  const paths = ['lib/board-facts.mjs', 'lib/core.mjs', 'package-lock.json']
  const loose = placeFiles(paths, [{ id: 'a' }])
  assert.deepEqual(loose.outside, [], 'no card has bounds, so nothing has strayed')
  assert.ok(loose.files.every((f) => !f.outside && f.card === null))

  const placed = placeFiles(paths, [{ id: 'mode', scope: ['lib/board-*.mjs'] }, { id: 'done', scope: ['lib/'], finished: true }])
  assert.deepEqual(placed.files.map((f) => [f.path, f.card, f.outside]), [
    ['lib/board-facts.mjs', 'mode', false],
    ['lib/core.mjs', null, true],
    ['package-lock.json', null, true],
  ])
  assert.deepEqual(placed.outside, [{ path: 'lib/core.mjs', near: 'mode' }, { path: 'package-lock.json', near: null }],
    'a stray file is noted near the card that shares its folder')
})

test('the branch is measured against main: commits ahead, committed, staged and untracked files, verified proof', async () => {
  const root = join(temp('repo'), 'app')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  write(root, 'README.md')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'checkout', '-q', '-b', 'feat/x')
  write(root, 'lib/board-a.mjs')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'board: a')
  const sha = git(root, 'rev-parse', '--short', 'HEAD')
  write(root, 'README.md', 'changed\n')
  write(root, 'notes/stray.txt')

  const data = temp('data')
  let now = Date.parse('2026-10-14T20:00:00Z')
  const facts = createBoardFacts({ root, dataDir: data, ttl: 0, now: () => now })
  const spaces = [{ id: 'mode', scope: ['lib/board-*.mjs', 'README.md'] }]
  const f = await facts.read(spaces)
  assert.equal(f.base, 'main')
  assert.equal(f.ahead, 1)
  assert.deepEqual(f.files.map((x) => x.path), ['README.md', 'lib/board-a.mjs', 'notes/stray.txt'])
  assert.deepEqual(f.commits.map((c) => [c.sha, c.subject]), [[sha, 'board: a']])
  assert.deepEqual(f.drift.map((d) => [d.path, d.since]), [['notes/stray.txt', '2026-10-14T20:00:00.000Z']])

  // first seen is kept, across a fresh reader too
  now += 60_000
  assert.equal((await facts.read(spaces)).drift[0].since, '2026-10-14T20:00:00.000Z')
  assert.equal(JSON.parse(readFileSync(join(data, 'board-drift.json'), 'utf8')).firstSeen['notes/stray.txt'], '2026-10-14T20:00:00.000Z')
  const again = createBoardFacts({ root, dataDir: data, ttl: 0, now: () => now })
  assert.equal((await again.read(spaces)).drift[0].since, '2026-10-14T20:00:00.000Z')
  // the change broadcast's fingerprint reads git alone and leaves first-seen be
  const print = await facts.fingerprint()
  assert.equal(await facts.fingerprint(), print)
  assert.equal((await facts.read(spaces)).drift[0].since, '2026-10-14T20:00:00.000Z')
  write(root, 'notes/two.txt')
  assert.notEqual(await facts.fingerprint(), print, 'a new file changes it')
  // brought under a scope, it stops being drift
  assert.deepEqual((await facts.read([{ id: 'mode', scope: ['lib/', 'notes/', 'README.md'] }])).drift, [])

  assert.deepEqual(await facts.commit(sha), { sha, subject: 'board: a' })
  assert.equal(await facts.commit('deadbee'), null)
  assert.equal(await facts.commit('HEAD; rm -rf /'), null, 'only a sha is ever passed to git')
  assert.equal(facts.file('lib/board-a.mjs'), 'lib/board-a.mjs')
  assert.equal(facts.file(join(root, 'README.md')), 'README.md')
  assert.equal(facts.file('../outside.txt'), null)
  assert.equal(facts.file('lib/missing.mjs'), null)
  assert.equal(facts.file('lib'), null, 'a folder is not proof')
})

test('on the base branch only uncommitted work counts, and a repo with no commits still reads', async () => {
  const root = join(temp('fresh'), 'app')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  write(root, 'a.txt')
  const facts = createBoardFacts({ root, ttl: 0 })
  const f = await facts.read([])
  assert.equal(f.ahead, 0)
  assert.deepEqual(f.files.map((x) => x.path), ['a.txt'])
  assert.deepEqual(f.commits, [])
})
