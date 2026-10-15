// Board facts: what git says, never what the agent claims. The board reads
// the branch's footing (its base, how far ahead, which files moved, including
// uncommitted and untracked ones), places each file under the card whose
// scope covers it, and calls a file outside any card's scope drift. Proof
// a task offers (a commit, a file) is checked here before its tick is inked.
// Everything is cached for a few seconds: /api/state is polled.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

const MAX_FILES = 400

/** Run git in the work tree; a failure reads as empty, never as a throw. */
export function runGit(cwd, args, timeout = 4000) {
  return new Promise((done) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 4 << 20 }, (err, out) => done(err ? '' : out.trim()))
  })
}

/** A scope glob as a test: `*` stays inside one folder, `**` crosses folders,
    and a bare folder ("lib" or "lib/") covers everything under it. */
export function scopeMatcher(globs = []) {
  const tests = globs.map((g) => String(g || '').trim().replace(/^\.\//, '')).filter(Boolean).map((g) => {
    if (!/[*?[]/.test(g)) {
      const plain = g.replace(/\/+$/, '')
      return (p) => p === plain || p.startsWith(`${plain}/`)
    }
    let re = ''
    for (let i = 0; i < g.length; i++) {
      const c = g[i]
      if (c === '*' && g[i + 1] === '*') {
        re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'
        i += g[i + 2] === '/' ? 2 : 1
      } else if (c === '*') re += '[^/]*'
      else if (c === '?') re += '[^/]'
      else re += c.replace(/[.+^${}()|\\[\]]/g, '\\$&')
    }
    const rx = new RegExp(`^${re}$`)
    return (p) => rx.test(p)
  })
  return (path) => tests.some((t) => t(path))
}

/** How alike two paths are: the number of leading folders they share. */
const shared = (a, b) => {
  const x = a.split('/'), y = b.replace(/\*.*$/, '').split('/').filter(Boolean)
  let n = 0
  while (n < x.length - 1 && n < y.length && x[n] === y[n]) n++
  return n
}

/**
 * Place each changed file under a card. `spaces` are the board's live cards
 * ({ id, scope }). Drift exists only once some card has declared a scope:
 * before that, nothing has bounds to stray outside of.
 */
export function placeFiles(paths, spaces) {
  const scoped = spaces.filter((s) => !s.finished && Array.isArray(s.scope) && s.scope.length)
  const tests = scoped.map((s) => ({ id: s.id, scope: s.scope, match: scopeMatcher(s.scope) }))
  const files = paths.map((path) => {
    const hit = tests.find((t) => t.match(path))
    return { path, card: hit?.id || null, outside: !!tests.length && !hit }
  })
  const near = (path) => {
    let best = null, score = 0
    for (const t of tests) for (const g of t.scope) {
      const n = shared(path, g)
      if (n > score) { score = n; best = t.id }
    }
    return best
  }
  return { files, outside: files.filter((f) => f.outside).map((f) => ({ path: f.path, near: near(f.path) })) }
}

/** The branch this one is measured against: origin's default, else main or master. */
async function baseOf(root, git) {
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const candidates = [head, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)
  for (const ref of candidates) {
    if (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return { ref, name: ref.replace(/^origin\//, '') }
  }
  return null
}

/**
 * One board's facts reader. `dataDir` keeps when each stray file was first
 * seen, so "since" survives a server restart.
 */
export function createBoardFacts({ root, dataDir, git = runGit, ttl = 4000, now = () => Date.now() }) {
  const seenFile = dataDir ? join(dataDir, 'board-drift.json') : null
  let firstSeen = {}
  try { if (seenFile && existsSync(seenFile)) firstSeen = JSON.parse(readFileSync(seenFile, 'utf8')).firstSeen || {} } catch {}
  let cached = null, cachedAt = 0, reading = null

  async function readGit() {
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const base = await baseOf(root, git)
    const onBase = !base || branch === base.name
    const fork = onBase ? '' : await git(root, ['merge-base', 'HEAD', base.ref])
    const range = fork ? `${fork}..HEAD` : ''
    const [aheadOut, logOut, diffOut, untrackedOut] = await Promise.all([
      range ? git(root, ['rev-list', '--count', range]) : '',
      range ? git(root, ['log', '--reverse', '--format=%h%x09%cI%x09%s', '-n', '200', range]) : '',
      git(root, ['diff', '--name-only', fork || 'HEAD']),
      git(root, ['ls-files', '--others', '--exclude-standard']),
    ])
    const commits = logOut ? logOut.split('\n').map((line) => {
      const [sha, at, ...subject] = line.split('\t')
      return { sha, at, subject: subject.join('\t') }
    }) : []
    const paths = [...new Set([...diffOut.split('\n'), ...untrackedOut.split('\n')].filter(Boolean))].sort().slice(0, MAX_FILES)
    return { base: base?.name || '', ahead: Number(aheadOut) || 0, commits, paths }
  }

  async function fresh() {
    if (!cached || now() - cachedAt > ttl) {
      reading ||= readGit().then((g) => { cached = g; cachedAt = now() }).finally(() => { reading = null })
      await reading
    }
    return cached
  }

  /** The facts for the board's current cards. */
  async function read(spaces = []) {
    await fresh()
    const { files, outside } = placeFiles(cached.paths, spaces)
    const stamp = new Date(now()).toISOString()
    let changed = false
    for (const f of outside) if (!firstSeen[f.path]) { firstSeen[f.path] = stamp; changed = true }
    for (const path of Object.keys(firstSeen)) if (!outside.some((f) => f.path === path)) { delete firstSeen[path]; changed = true }
    if (changed && seenFile) writeFile(seenFile, JSON.stringify({ firstSeen }, null, 2) + '\n').catch(() => {})
    return {
      base: cached.base,
      ahead: cached.ahead,
      files,
      drift: outside.map((f) => ({ ...f, since: firstSeen[f.path] })),
      commits: cached.commits,
    }
  }

  /** Drop the cache: a tool call just changed what the board knows. */
  const invalidate = () => { cachedAt = 0 }

  /** Is this a commit in the repo? Returns its short sha and subject. */
  async function commit(ref) {
    const sha = String(ref || '').trim()
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) return null
    const out = await git(root, ['show', '-s', '--format=%h%x09%s', `${sha}^{commit}`])
    if (!out) return null
    const [short, ...subject] = out.split('\t')
    return { sha: short, subject: subject.join('\t') }
  }

  /** Does this file exist inside the work tree? Returns its path from the root. */
  function file(path) {
    const raw = String(path || '').trim()
    if (!raw) return null
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
    const rel = relative(root, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    try { return statSync(abs).isFile() ? rel.split('\\').join('/') : null } catch { return null }
  }

  /** A fingerprint of what git says, for the change broadcast. It reads git
      only: placing files needs the cards, and drift's first-seen times with them. */
  async function fingerprint() {
    invalidate()
    const g = await fresh()
    return JSON.stringify([g.ahead, g.paths, g.commits.at(-1)?.sha || ''])
  }

  return { read, invalidate, commit, file, fingerprint }
}
