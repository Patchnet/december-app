import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  callWebTool,
  decodeEntities,
  extractText,
  fetchPage,
  guardUrl,
  isWebTool,
  normalizeResultUrl,
  parseSearchResults,
  privateAddress,
  searchWeb,
  WEB_TOOLS,
} from '../lib/web-lookup.mjs'

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }]
const html = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const page = (body, type = 'text/html') => new Response(body, { headers: { 'content-type': type } })

function recorder(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    return handler(url, init)
  }
  return { calls, fetchImpl }
}

// ------------------------------------------------------------- the guards

test('private, loopback, and link-local addresses are never open web', () => {
  for (const host of [
    '127.0.0.1', '127.13.2.9', '0.0.0.0', '10.4.4.4', '172.16.0.1', '172.31.255.255',
    '192.168.1.5', '169.254.169.254', '100.64.0.1', '::1', '::', 'fd00::1', 'fe80::1',
    '[::1]', '::ffff:127.0.0.1', '239.1.1.1', '',
  ]) {
    assert.equal(privateAddress(host), true, `${host} should be refused`)
  }
  for (const host of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1::1']) {
    assert.equal(privateAddress(host), false, `${host} should be allowed`)
  }
})

test('guardUrl refuses everything that is not a public http(s) page', () => {
  for (const url of [
    'http://localhost:3008/api/tool',
    'http://127.0.0.1:3008/api/tool',
    'https://169.254.169.254/latest/meta-data/',
    'https://192.168.1.5/router',
    'https://printer.local/status',
    'https://wiki.internal/secrets',
    'https://intranet/',
    'file:///C:/Users/secrets.txt',
    'ftp://example.com/x',
    'not a url at all',
    '',
  ]) {
    assert.throws(() => guardUrl(url), /never answer from memory/, `${url} should be refused`)
  }
  assert.equal(guardUrl('https://example.com/schedule?x=1').hostname, 'example.com')
})

test('a public name that resolves home is refused, and no socket opens', async () => {
  const { calls, fetchImpl } = recorder(() => page(html('<p>hi</p>')))
  await assert.rejects(
    fetchPage({ url: 'https://rebind.example.com/' }, {
      fetchImpl,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    /resolves off the open web/
  )
  assert.deepEqual(calls, [], 'the fetch must not happen once the name resolves home')
})

test('a loopback url is refused before the request is made', async () => {
  const { calls, fetchImpl } = recorder(() => page(html('<p>hi</p>')))
  await assert.rejects(
    fetchPage({ url: 'http://localhost:3008/api/tool' }, { fetchImpl, lookup: publicDns }),
    /not on the open web/
  )
  assert.deepEqual(calls, [])
})

test('a redirect toward loopback is refused at the hop', async () => {
  const { calls, fetchImpl } = recorder((url) =>
    url.startsWith('https://example.com')
      ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3008/api/tool' } })
      : page(html('<p>the page</p>'))
  )
  await assert.rejects(
    fetchPage({ url: 'https://example.com/go' }, { fetchImpl, lookup: publicDns }),
    /not on the open web/
  )
  assert.deepEqual(calls, ['https://example.com/go'], 'only the first hop is allowed to happen')
})

test('a redirect loop ends, it does not spin', async () => {
  let n = 0
  const fetchImpl = async () => {
    n++
    return new Response(null, { status: 301, headers: { location: `https://example.com/hop${n}` } })
  }
  await assert.rejects(
    fetchPage({ url: 'https://example.com/hop0' }, { fetchImpl, lookup: publicDns }),
    /kept redirecting/
  )
  assert.ok(n <= 5, `stopped after ${n} hops`)
})

// -------------------------------------------------------------- fetching

test('fetching returns the page text, the final url, and the filing rule', async () => {
  const { fetchImpl } = recorder(() =>
    page(html('<h1>Home schedule</h1><p>Sept 6 vs Miami, 3:30 pm ET</p><script>var x=1</script>', '<title>2026 Schedule</title>'))
  )
  const out = await fetchPage({ url: 'https://example.com/schedule' }, { fetchImpl, lookup: publicDns })
  assert.equal(out.url, 'https://example.com/schedule')
  assert.equal(out.title, '2026 Schedule')
  assert.match(out.text, /Sept 6 vs Miami, 3:30 pm ET/)
  assert.doesNotMatch(out.text, /var x=1/)
  assert.equal(out.truncated, false)
  assert.match(out.note, /never fill a gap from memory/)
  assert.ok(!Number.isNaN(Date.parse(out.fetchedAt)))
})

test('a page that is not readable text becomes a look-up task, not a guess', async () => {
  const { fetchImpl } = recorder(() => page('%PDF-1.7 binary', 'application/pdf'))
  await assert.rejects(
    fetchPage({ url: 'https://example.com/schedule.pdf' }, { fetchImpl, lookup: publicDns }),
    /not readable text.*file a look-up task/s
  )
})

test('an error, an empty page, and an unreachable host all end in a look-up task', async () => {
  const lookup = publicDns
  await assert.rejects(
    fetchPage({ url: 'https://example.com/gone' }, {
      lookup,
      fetchImpl: async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
    }),
    /answered 404.*file a look-up task/s
  )
  await assert.rejects(
    fetchPage({ url: 'https://example.com/empty' }, { lookup, fetchImpl: async () => page(html('<script>x</script>')) }),
    /no readable text.*file a look-up task/s
  )
  await assert.rejects(
    fetchPage({ url: 'https://example.com/down' }, {
      lookup,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    }),
    /could not reach example\.com.*file a look-up task/s
  )
  await assert.rejects(
    fetchPage({ url: 'https://example.com/dns' }, { lookup: async () => [], fetchImpl: async () => page('x') }),
    /resolves off the open web/
  )
})

test('an enormous page is capped instead of swallowed whole', async () => {
  const body = html('<p>a very long line of text</p>'.repeat(40_000))
  assert.ok(body.length > 400_000)
  const { fetchImpl } = recorder(() => page(body))
  const out = await fetchPage({ url: 'https://example.com/big' }, { fetchImpl, lookup: publicDns })
  assert.ok(out.text.length <= 8_000, `text was ${out.text.length}`)
  assert.equal(out.truncated, true)
})

// --------------------------------------------------------------- reading

test('text extraction drops markup and script, and decodes entities', () => {
  const { title, text } = extractText(
    html(
      '<style>.a{color:red}</style><!-- note --><div>Tickets &amp; parking</div><p>7&nbsp;pm &#8211; gates open</p><script>alert(1)</script>',
      '<title>Game&nbsp;day</title>'
    )
  )
  assert.equal(title, 'Game day')
  assert.match(text, /Tickets & parking/)
  assert.match(text, /7 pm/)
  assert.doesNotMatch(text, /alert\(1\)/)
  assert.doesNotMatch(text, /color:red/)
  assert.doesNotMatch(text, /note/)
  assert.doesNotMatch(text, /</)
  assert.equal(decodeEntities('&unknown; &#x41;'), '&unknown; A')
})

// -------------------------------------------------------------- searching

const RESULTS = `<div class="results">
  <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffloridagators.com%2Fschedule&amp;rut=9">Official 2026 schedule</a>
    <a class="result__snippet">Home games at Ben Hill Griffin Stadium</a></div>
  <div class="result"><a class="result__a" href="https://sports-aggregator.example/uf">Gators on Aggregator</a>
    <a class="result__snippet">Scores, odds, and more</a></div>
  <div class="result"><a class="result__a" href="http://127.0.0.1:3008/api/tool">local</a>
    <a class="result__snippet">not a result</a></div>
</div>`

test('search results are unwrapped, paired with snippets, and deduped', () => {
  const results = parseSearchResults(RESULTS)
  assert.equal(results.length, 2, 'the loopback link must not survive')
  assert.deepEqual(results[0], {
    title: 'Official 2026 schedule',
    url: 'https://floridagators.com/schedule',
    snippet: 'Home games at Ben Hill Griffin Stadium',
  })
  assert.equal(results[1].url, 'https://sports-aggregator.example/uf')
  assert.equal(parseSearchResults(RESULTS, 1).length, 1)
  assert.deepEqual(parseSearchResults('<html><body>no results here</body></html>'), [])
  assert.deepEqual(parseSearchResults(''), [])
})

test('redirector links resolve to the destination, junk resolves to nothing', () => {
  assert.equal(normalizeResultUrl('//example.com/a#frag'), 'https://example.com/a')
  assert.equal(normalizeResultUrl('/l/?uddg=https%3A%2F%2Fx.example%2Fy'), null, 'a relative link is not a destination')
  assert.equal(normalizeResultUrl('https://r.example/l/?uddg=https%3A%2F%2Fx.example%2Fy'), 'https://x.example/y')
  assert.equal(normalizeResultUrl(''), null)
  assert.equal(normalizeResultUrl('javascript:alert(1)'), 'javascript:alert(1)', 'shape only; guardUrl refuses the scheme')
  assert.throws(() => guardUrl('javascript:alert(1)'), /only http and https/)
})

test('searching sends the query to the configured endpoint and never invents results', async (t) => {
  const previous = process.env.DECEMBER_SEARCH_URL
  process.env.DECEMBER_SEARCH_URL = 'https://search.example/?q={query}'
  t.after(() => {
    if (previous === undefined) delete process.env.DECEMBER_SEARCH_URL
    else process.env.DECEMBER_SEARCH_URL = previous
  })

  const { calls, fetchImpl } = recorder(() => page(RESULTS))
  const out = await searchWeb({ query: '  uf home schedule  ', limit: 99 }, { fetchImpl, lookup: publicDns })
  assert.deepEqual(calls, ['https://search.example/?q=uf%20home%20schedule'])
  assert.equal(out.query, 'uf home schedule')
  assert.equal(out.results.length, 2)
  assert.match(out.note, /snippets are not facts/)

  const empty = await searchWeb({ query: 'nothing' }, { fetchImpl: async () => page('<html></html>'), lookup: publicDns })
  assert.deepEqual(empty.results, [])
  assert.match(empty.note, /file a look-up task/)

  await assert.rejects(searchWeb({ query: '   ' }, { fetchImpl, lookup: publicDns }), /say what to look up/)
})

// ------------------------------------------------------------ the surface

test('the lookup tools are December tools, strict, and say when not to use them', () => {
  assert.deepEqual(WEB_TOOLS.map((t) => t.name), ['december_web_search', 'december_web_fetch'])
  for (const tool of WEB_TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(isWebTool(tool.name))
  }
  const [search, fetchTool] = WEB_TOOLS
  assert.match(search.description, /ONLY when a capture explicitly asks/)
  assert.match(search.description, /milk/i)
  assert.match(fetchTool.description, /Never invent/)
  assert.match(fetchTool.description, /file a look-up task/)
  assert.equal(isWebTool('december_view'), false)
})

test('dispatch answers only its own two tools', async () => {
  const { fetchImpl } = recorder(() => page(html('<p>hello</p>')))
  const deps = { fetchImpl, lookup: publicDns }
  assert.equal((await callWebTool('december_web_fetch', { url: 'https://example.com/a' }, deps)).title, '')
  assert.equal((await callWebTool('december_web_search', { query: 'x' }, deps)).query, 'x')
  await assert.rejects(callWebTool('december_capture', { text: 'milk' }, deps), /unknown tool/)
})

// ------------------------------------------------------------ the adapter
// The lookup tools have to arrive over the same stdio server both engines
// already run, or "harness-neutral" is only a claim. This drives the real
// adapter against a stand-in December server, so no page state is touched.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

async function adapter(t) {
  const pageTools = [{ name: 'december_view', description: 'the page', inputSchema: { type: 'object' } }]
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tools') return res.end(JSON.stringify({ tools: pageTools }))
    if (req.url === '/api/manners') return res.end(JSON.stringify({ manners: '' }))
    if (req.url === '/api/tool') return res.end(JSON.stringify({ result: { forwarded: true } }))
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const child = spawn(process.execPath, [join(ROOT, 'mcp-server.mjs')], {
    env: { ...process.env, DECEMBER_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const pending = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  t.after(() => {
    child.kill()
    server.closeAllConnections?.()
    server.close()
  })
  let id = 0
  return (method, params) =>
    new Promise((resolve, reject) => {
      const rpcId = ++id
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000)
      pending.set(rpcId, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }) + '\n')
    })
}

test('the MCP adapter advertises the lookup tools and answers them itself', async (t) => {
  const call = await adapter(t)
  const listed = (await call('tools/list', {})).result.tools.map((tool) => tool.name)
  assert.deepEqual(listed, ['december_view', 'december_web_search', 'december_web_fetch'])

  // A page tool still crosses to the server; the lookup tool never does.
  const forwarded = await call('tools/call', { name: 'december_view', arguments: {} })
  assert.match(forwarded.result.content[0].text, /"forwarded":true/)

  const refused = await call('tools/call', {
    name: 'december_web_fetch',
    arguments: { url: 'http://127.0.0.1:3008/api/tool' },
  })
  assert.equal(refused.result.isError, true)
  assert.match(refused.result.content[0].text, /not on the open web/)
  assert.match(refused.result.content[0].text, /file a look-up task/)
})
