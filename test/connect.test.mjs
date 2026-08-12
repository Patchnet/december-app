import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWizard } from '../connect.mjs'
import {
  CLIENTS,
  connectionPaths,
  detect,
  publishSkills,
  register,
  statuses,
  writeCodexRegistration,
} from '../lib/connect.mjs'

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'december-connect-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'app')
  const home = join(base, 'home')
  const appData = join(home, 'AppData', 'Roaming')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'mcp-server.mjs'), '// fixture adapter\n')
  return {
    base,
    root,
    home,
    appData,
    platform: 'win32',
    url: 'http://localhost:3918',
    binaries: { claude: 'fixture-claude', codex: 'fixture-codex' },
    fetch: async () => ({ ok: true, json: async () => ({ tools: [] }) }),
    run: async (_bin, args) => {
      if (args[0] === '--version') return { stdout: '1.0.0', stderr: '' }
      if (args[0] === 'mcp' && args[1] === 'list') return { stdout: 'december: node adapter - Connected', stderr: '' }
      return { stdout: '', stderr: '' }
    },
  }
}

async function putJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

test('Claude Desktop registration preserves keys and creates one original backup', async (t) => {
  const o = await fixture(t)
  const paths = connectionPaths(o)
  const original = { theme: 'quiet', mcpServers: { another: { command: 'keep' } } }
  await putJson(paths.claudeDesktop, original)

  await register('claude-desktop', o)
  const written = JSON.parse(await readFile(paths.claudeDesktop, 'utf8'))
  assert.equal(written.theme, 'quiet')
  assert.deepEqual(written.mcpServers.another, { command: 'keep' })
  assert.deepEqual(written.mcpServers.december, {
    command: 'node',
    args: [paths.adapter],
    env: { DECEMBER_URL: o.url },
  })
  assert.deepEqual(JSON.parse(await readFile(paths.claudeDesktopBackup, 'utf8')), original)

  await register('claude-desktop', { ...o, url: 'http://localhost:3919' })
  assert.deepEqual(JSON.parse(await readFile(paths.claudeDesktopBackup, 'utf8')), original)
})

test('Claude Code registration invokes the resolved binary with argument arrays', async (t) => {
  const o = await fixture(t)
  const calls = []
  await register('claude-code', {
    ...o,
    run: async (bin, args) => {
      calls.push({ bin, args })
      return { stdout: '', stderr: '' }
    },
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], {
    bin: 'fixture-claude',
    args: ['mcp', 'remove', 'december', '--scope', 'user'],
  })
  assert.deepEqual(calls[1], {
    bin: 'fixture-claude',
    args: [
      'mcp', 'add', '--scope', 'user', '--env', `DECEMBER_URL=${o.url}`,
      'december', '--', 'node', join(o.root, 'mcp-server.mjs'),
    ],
  })
})

test('Codex registration appends and replaces only December with forward-slash paths', async (t) => {
  const o = await fixture(t)
  const paths = connectionPaths(o)
  await mkdir(join(o.home, '.codex'), { recursive: true })
  await writeFile(paths.codex, 'model = "example"\n\n[mcp_servers.other]\ncommand = "keep"\n')

  await register('codex', o)
  const first = await readFile(paths.codex, 'utf8')
  assert.match(first, /model = "example"/)
  assert.match(first, /\[mcp_servers\.other\]/)
  assert.match(first, /\[mcp_servers\.december\]/)
  assert.ok(first.includes(paths.adapter.replaceAll('\\', '/')))
  assert.ok(!first.includes(paths.adapter.replaceAll('/', '\\')))

  const replaced = writeCodexRegistration(first, { adapter: 'C:\\next\\mcp-server.mjs', url: 'http://localhost:4000' })
  assert.equal((replaced.match(/\[mcp_servers\.december\]/g) || []).length, 1)
  assert.match(replaced, /C:\/next\/mcp-server\.mjs/)
  assert.match(replaced, /localhost:4000/)
  assert.match(replaced, /mcp_servers\.other/)
})

test('Cursor registration preserves unrelated servers and fields', async (t) => {
  const o = await fixture(t)
  const paths = connectionPaths(o)
  await putJson(paths.cursor, { editor: 'keep', mcpServers: { another: { url: 'http://example.test' } } })

  await register('cursor', o)
  const written = JSON.parse(await readFile(paths.cursor, 'utf8'))
  assert.equal(written.editor, 'keep')
  assert.equal(written.mcpServers.another.url, 'http://example.test')
  assert.equal(written.mcpServers.december.env.DECEMBER_URL, o.url)
})

const skill = (version, note = '') => `---\nname: december\nversion: ${version}\n---\n\n# December\n${note}\n`

test('skill publishing overwrites older copies, keeps newer copies, and creates missing copies', async (t) => {
  const o = await fixture(t)
  const paths = connectionPaths(o)
  await mkdir(paths.sourceSkill, { recursive: true })
  await writeFile(join(paths.sourceSkill, 'SKILL.md'), skill('0.7.0', 'source'))
  await writeFile(join(paths.sourceSkill, 'note.txt'), 'mirrored')
  await mkdir(paths.skillTargets.claude, { recursive: true })
  await mkdir(paths.skillTargets.codex, { recursive: true })
  await writeFile(join(paths.skillTargets.claude, 'SKILL.md'), skill('0.6.0', 'old'))
  await writeFile(join(paths.skillTargets.claude, 'stale.txt'), 'remove me')
  await writeFile(join(paths.skillTargets.codex, 'SKILL.md'), skill('0.8.0', 'newer'))

  const result = await publishSkills(o)
  assert.equal(result.claude.status, 'published')
  assert.equal(result.codex.status, 'kept')
  assert.equal(result.cursor.status, 'published')
  assert.match(await readFile(join(paths.skillTargets.claude, 'SKILL.md'), 'utf8'), /source/)
  await assert.rejects(() => readFile(join(paths.skillTargets.claude, 'stale.txt')), /ENOENT/)
  assert.match(await readFile(join(paths.skillTargets.codex, 'SKILL.md'), 'utf8'), /newer/)
  assert.equal(await readFile(join(paths.skillTargets.cursor, 'note.txt'), 'utf8'), 'mirrored')
})

test('skill publishing uses the unpacked public mirror when the root skill is absent', async (t) => {
  const o = await fixture(t)
  const paths = connectionPaths(o)
  await mkdir(paths.packagedSkill, { recursive: true })
  await writeFile(join(paths.packagedSkill, 'SKILL.md'), skill('0.7.0', 'packaged'))
  await publishSkills(o)
  assert.match(await readFile(join(paths.skillTargets.codex, 'SKILL.md'), 'utf8'), /packaged/)
})

test('the packaged skill mirror stays byte-for-byte aligned with the canonical skill', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  assert.equal(
    await readFile(join(root, 'public', 'skills', 'december', 'SKILL.md'), 'utf8'),
    await readFile(join(root, 'skills', 'december', 'SKILL.md'), 'utf8')
  )
})

test('detect returns a stable client shape without writing configuration', async (t) => {
  const o = await fixture(t)
  const paths = connectionPaths(o)
  await putJson(paths.claudeDesktop, { mcpServers: { december: {} } })
  await putJson(paths.cursor, { mcpServers: {} })
  await mkdir(join(o.home, '.codex'), { recursive: true })
  await writeFile(paths.codex, '[mcp_servers.december]\ncommand = "node"\n')

  const found = await detect(o)
  assert.deepEqual(Object.keys(found), CLIENTS)
  for (const client of CLIENTS) {
    assert.equal(found[client].client, client)
    assert.equal(typeof found[client].installed, 'boolean')
    assert.ok([true, false, null].includes(found[client].registered))
  }
  assert.equal(found['claude-code'].registered, true)
  assert.equal(found['claude-desktop'].registered, true)
  assert.equal(found.codex.registered, true)
  assert.equal(found.cursor.registered, false)
})

test('status board uses connected, available, and not-installed states', async (t) => {
  const o = await fixture(t)
  const paths = connectionPaths(o)
  await putJson(paths.claudeDesktop, { mcpServers: { december: {} } })
  await putJson(paths.cursor, { mcpServers: {} })
  const board = await statuses({
    ...o,
    run: async (bin, args) => {
      if (args[0] === '--version' && bin === 'fixture-codex') throw new Error('missing')
      return o.run(bin, args)
    },
  })
  assert.equal(board['claude-code'].state, 'connected')
  assert.equal(board['claude-desktop'].state, 'connected')
  assert.equal(board.codex.state, 'not-installed')
  assert.equal(board.cursor.state, 'available')
})

test('non-interactive wizard writes only the injected fixture home and exits cleanly', async (t) => {
  const o = await fixture(t)
  const paths = connectionPaths(o)
  await putJson(paths.cursor, { fixture: true, mcpServers: {} })
  await mkdir(paths.sourceSkill, { recursive: true })
  await writeFile(join(paths.sourceSkill, 'SKILL.md'), skill('0.7.0', 'source'))
  let printed = ''
  const code = await runWizard({
    argv: ['--yes', '--clients', 'cursor'],
    options: o,
    write: { write: (chunk) => { printed += chunk } },
  })
  assert.equal(code, 0)
  assert.match(printed, /December connection doctor/)
  assert.match(printed, /Cursor\s+connected/)
  const cursor = JSON.parse(await readFile(paths.cursor, 'utf8'))
  assert.equal(cursor.fixture, true)
  assert.equal(cursor.mcpServers.december.env.DECEMBER_URL, o.url)
})
