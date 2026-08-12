// docx extraction — build a minimal real .docx (zip + document.xml) in
// memory and assert the text comes out flat and entity-decoded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { docxText } from '../lib/docx.mjs'

/** Tiny single-entry zip with a deflated word/document.xml. */
function makeDocx(xml) {
  const name = Buffer.from('word/document.xml')
  const data = Buffer.from(xml, 'utf8')
  const comp = deflateRawSync(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8) // deflate
  local.writeUInt32LE(comp.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(comp.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42) // local header offset

  const centralStart = 30 + name.length + comp.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + name.length, 12)
  eocd.writeUInt32LE(centralStart, 16)

  return Buffer.concat([local, name, comp, central, name, eocd])
}

test('extracts paragraphs as lines with entities decoded', () => {
  const xml =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>Chicken &amp; Rice</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">two </w:t></w:r><w:r><w:t>runs</w:t></w:r></w:p>' +
    '<w:p></w:p>' +
    '</w:body></w:document>'
  const text = docxText(makeDocx(xml))
  assert.equal(text, 'Chicken & Rice\ntwo runs')
})

test('rejects a non-zip buffer', () => {
  assert.throws(() => docxText(Buffer.from('not a zip at all')), /not a zip/)
})

test('rejects a docx with no text', () => {
  assert.throws(() => docxText(makeDocx('<w:document><w:body></w:body></w:document>')), /no text/)
})
