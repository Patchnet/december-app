// Who December answers. A link is a person; a script is not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foreignFetchSite } from '../lib/fetch-site.mjs'

const visit = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
const script = { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }

test('December answers its own page, and a person typing the address', () => {
  assert.equal(foreignFetchSite({ 'sec-fetch-site': 'same-origin', ...script }, 'GET'), false)
  assert.equal(foreignFetchSite({ 'sec-fetch-site': 'same-origin', ...script }, 'POST'), false)
  assert.equal(foreignFetchSite({ 'sec-fetch-site': 'none', ...visit }, 'GET'), false)
})

test('a client that is not a browser stamps nothing and is ours', () => {
  assert.equal(foreignFetchSite({}, 'GET'), false)
  assert.equal(foreignFetchSite({}, 'POST'), false)
})

test('following a link to December opens December', () => {
  for (const site of ['cross-site', 'same-site']) {
    assert.equal(foreignFetchSite({ 'sec-fetch-site': site, ...visit }, 'GET'), false,
      `a top-level visit from ${site} is a person arriving`)
  }
})

test('another page reaching in for December\'s answers is refused', () => {
  // The dangerous shapes: a script asking for data, a form posting across,
  // a subresource load, and a navigation that would change something.
  assert.equal(foreignFetchSite({ 'sec-fetch-site': 'cross-site', ...script }, 'GET'), true)
  assert.equal(foreignFetchSite({ 'sec-fetch-site': 'cross-site', ...visit }, 'POST'), true)
  assert.equal(foreignFetchSite({ 'sec-fetch-site': 'cross-site', ...script }, 'POST'), true)
  assert.equal(foreignFetchSite({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, 'GET'), true)
  // An iframe is a navigate too, but for a nested document — X-Frame-Options
  // already refuses it; the guard does not have to be the one to say no.
  assert.equal(foreignFetchSite({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, 'GET'), true)
})
