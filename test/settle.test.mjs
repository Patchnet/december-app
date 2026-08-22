import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOWED, PROMPT, parseSurfaceReply, runEnginePrompt } from '../lib/settle.mjs'
import { WEB_TOOLS } from '../lib/web-lookup.mjs'

test('surface reply parsing extracts a fenced array and validates items', () => {
  const raw = 'Here you go:\n```json\n[{"label":"Call Ana","reason":"waiting","space":"People","until":"2026-08-15"}]\n```\n'
  assert.deepEqual(parseSurfaceReply(raw), [{ label: 'Call Ana', reason: 'waiting', space: 'People', until: '2026-08-15' }])
  assert.deepEqual(parseSurfaceReply('normal answer: []'), [])
})

test('surface reply parsing rejects malformed item shapes and dates', () => {
  assert.throws(() => parseSurfaceReply('[{"label":12,"space":"People"}]'), /no valid surface list/)
  assert.throws(() => parseSurfaceReply('[{"label":"Call Ana","space":4}]'), /no valid surface list/)
  assert.throws(() => parseSurfaceReply('[{"label":"Call Ana","space":"People","until":"2026-02-30"}]'), /no valid surface list/)
})

async function fakeCli(t) {
  const dir = await mkdtemp(join(tmpdir(), 'december-fake-cli-'))
  const script = join(dir, 'fake-cli.mjs')
  const record = join(dir, 'record.json')
  await writeFile(script, `
import { writeFileSync } from 'node:fs'

const mode = process.env.FAKE_CLI_MODE || 'ok'
const record = (stdin) => writeFileSync(
  process.env.FAKE_CLI_RECORD,
  JSON.stringify({ argv: process.argv.slice(2), stdin })
)

if (mode === 'early-close') {
  record('')
  process.stdin.destroy()
  process.exit(0)
}

const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  record(Buffer.concat(chunks).toString('utf8'))
  if (mode === 'nonzero') {
    process.stderr.write('fixture failed', () => process.exit(7))
  } else if (mode === 'timeout') {
    setTimeout(() => {}, 10_000)
  } else if (mode === 'overflow') {
    process.stdout.write('x'.repeat(4096))
  } else {
    process.stdout.write('ok')
  }
})
`)
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { script, record }
}

test('Claude and Codex prompts use stdin and never argv', async (t) => {
  const fixture = await fakeCli(t)
  const sentinel = 'private-page-sentinel-2f632ce6'
  for (const engine of ['claude', 'codex']) {
    const env = { ...process.env, FAKE_CLI_MODE: 'ok', FAKE_CLI_RECORD: fixture.record }
    const out = await runEnginePrompt(engine, sentinel, {
      binary: process.execPath,
      prefixArgs: [fixture.script],
      env,
      timeout: 2_000,
      maxBuffer: 1_024,
    })
    assert.equal(out.stdout, 'ok')
    const invocation = JSON.parse(await readFile(fixture.record, 'utf8'))
    assert.equal(invocation.stdin, sentinel)
    assert.ok(!invocation.argv.includes(sentinel), `${engine} exposed the prompt in argv`)
    if (engine === 'codex') assert.equal(invocation.argv[1], '-')
    if (engine === 'claude') assert.equal(invocation.argv[0], '-p')
  }
})

test('lookup reaches the settle agent as December MCP tools, not engine builtins', () => {
  const tools = ALLOWED.split(',')
  for (const tool of WEB_TOOLS) {
    assert.ok(tools.includes(`mcp__december__${tool.name}`), `${tool.name} must be allowed during a settle`)
  }
  // Claude's own web tools would give Codex settles a different page, and a
  // shell or an editor has no business in someone's page at all.
  for (const banned of ['WebSearch', 'WebFetch', 'Bash', 'Write', 'Edit', 'Glob', 'Grep', 'Task']) {
    assert.ok(!tools.includes(banned), `${banned} must never be allowed during a settle`)
  }
  assert.ok(tools.every((t) => t === 'Read' || t.startsWith('mcp__december__december_')))
})

test('the standing instructions gate lookup on an explicit ask and forbid inventing', () => {
  const prompt = PROMPT()
  assert.match(prompt, /december_web_search/)
  assert.match(prompt, /december_web_fetch/)
  assert.match(prompt, /only when a capture explicitly asks/i)
  assert.match(prompt, /Milk stays milk/i)
  assert.match(prompt, /Never invent a date, a time, a score, a price, or a name/)
  assert.match(prompt, /file a look-up task instead/)
  assert.match(prompt, /an ordinary capture is never looked up/)
  assert.match(prompt, /a search snippet is never a fact/)
})

test('a codex settle gets the same December MCP surface as the Claude agent', async (t) => {
  const fixture = await fakeCli(t)
  await runEnginePrompt('codex', 'sentinel', {
    binary: process.execPath,
    prefixArgs: [fixture.script],
    env: { ...process.env, FAKE_CLI_MODE: 'ok', FAKE_CLI_RECORD: fixture.record },
    timeout: 2_000,
    maxBuffer: 1_024,
  })
  const { argv } = JSON.parse(await readFile(fixture.record, 'utf8'))
  assert.ok(argv.includes('mcp_servers.december.command="node"'), 'codex must run December\'s own MCP server')
  assert.ok(argv.some((a) => /mcp_servers\.december\.args=.*mcp-server\.mjs/.test(a)))
  assert.ok(argv.includes('sandbox_mode="read-only"'), 'lookup must not come with a writable sandbox')
})

test('one-shot engine process failures stay bounded and controlled', async (t) => {
  const fixture = await fakeCli(t)
  const run = (mode, options = {}) => runEnginePrompt('codex', 'sentinel', {
    binary: process.execPath,
    prefixArgs: [fixture.script],
    env: { ...process.env, FAKE_CLI_MODE: mode, FAKE_CLI_RECORD: fixture.record },
    timeout: options.timeout ?? 2_000,
    maxBuffer: options.maxBuffer ?? 1_024,
  })

  const closed = await run('early-close')
  assert.equal(closed.stdout, '')
  await assert.rejects(run('nonzero'), (error) => error.code === 7 && /fixture failed/.test(error.stderr))
  await assert.rejects(run('timeout', { timeout: 100 }), (error) => error.killed === true)
  await assert.rejects(
    run('overflow', { maxBuffer: 128 }),
    (error) => error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  )
})
