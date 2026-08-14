// A small, local QR encoder for December's one-time Pocket link. It emits a
// smallest of three L-level symbols that fits, keeping normal pairing codes
// easy to scan while still allowing an 858-byte URL. Nothing leaves the page.

const CONFIGS = [
  { version: 10, dataBytes: 274, blocks: [68, 68, 69, 69], totals: [86, 86, 87, 87], alignment: [6, 28, 50] },
  { version: 17, dataBytes: 647, blocks: [107, 108, 108, 108, 108, 108], totals: [135, 136, 136, 136, 136, 136], alignment: [6, 30, 54, 78] },
  { version: 20, dataBytes: 861, blocks: [107, 107, 107, 108, 108, 108, 108, 108], totals: [135, 135, 135, 136, 136, 136, 136, 136], alignment: [6, 34, 62, 90] },
]
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

let value = 1
for (let i = 0; i < 255; i++) {
  EXP[i] = value
  LOG[value] = i
  value <<= 1
  if (value & 0x100) value ^= 0x11d
}
for (let i = 255; i < EXP.length; i++) EXP[i] = EXP[i - 255]

const multiply = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

function generator(degree) {
  let out = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(out.length + 1).fill(0)
    for (let j = 0; j < out.length; j++) {
      next[j] ^= out[j]
      next[j + 1] ^= multiply(out[j], EXP[i])
    }
    out = next
  }
  return out
}

function errorCorrection(data, count) {
  const divisor = generator(count)
  const remainder = new Uint8Array(count)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[count - 1] = 0
    for (let i = 0; i < count; i++) remainder[i] ^= multiply(divisor[i + 1], factor)
  }
  return remainder
}

class Bits {
  constructor() { this.values = [] }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.values.push((value >>> i) & 1)
  }
  bytes() {
    const out = new Uint8Array(this.values.length / 8)
    for (let i = 0; i < this.values.length; i++) out[i >>> 3] |= this.values[i] << (7 - (i & 7))
    return out
  }
}

function encodePayload(payload, config) {
  const bits = new Bits()
  bits.push(0b0100, 4) // byte mode
  bits.push(payload.length, 16)
  for (const byte of payload) bits.push(byte, 8)
  bits.push(0, Math.min(4, config.dataBytes * 8 - bits.values.length))
  while (bits.values.length % 8) bits.push(0, 1)
  let pad = true
  while (bits.values.length < config.dataBytes * 8) {
    bits.push(pad ? 0xec : 0x11, 8)
    pad = !pad
  }

  const raw = bits.bytes()
  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (let i = 0; i < config.blocks.length; i++) {
    const block = raw.slice(offset, offset + config.blocks[i])
    dataBlocks.push(block)
    ecBlocks.push(errorCorrection(block, config.totals[i] - config.blocks[i]))
    offset += config.blocks[i]
  }

  const out = []
  for (let i = 0; i < Math.max(...config.blocks); i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i])
  }
  for (let i = 0; i < ecBlocks[0].length; i++) {
    for (const block of ecBlocks) out.push(block[i])
  }
  return out
}

function bch(value, polynomial) {
  const degree = 31 - Math.clz32(polynomial)
  let shifted = value << degree
  while (31 - Math.clz32(shifted) >= degree) shifted ^= polynomial << ((31 - Math.clz32(shifted)) - degree)
  return shifted
}

function placeFinder(modules, row, column) {
  const size = modules.length
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r
      const x = column + c
      if (y < 0 || y >= size || x < 0 || x >= size) continue
      modules[y][x] = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
        (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
    }
  }
}

function baseMatrix(config) {
  const size = config.version * 4 + 17
  const modules = Array.from({ length: size }, () => Array(size).fill(null))
  placeFinder(modules, 0, 0)
  placeFinder(modules, size - 7, 0)
  placeFinder(modules, 0, size - 7)

  for (const row of config.alignment) {
    for (const column of config.alignment) {
      if (modules[row][column] !== null) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) modules[row + r][column + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    if (modules[i][6] === null) modules[i][6] = i % 2 === 0
    if (modules[6][i] === null) modules[6][i] = i % 2 === 0
  }

  const versionBits = (config.version << 12) | bch(config.version, 0x1f25)
  for (let i = 0; i < 18; i++) {
    const bit = ((versionBits >>> i) & 1) === 1
    modules[Math.floor(i / 3)][i % 3 + size - 11] = bit
    modules[i % 3 + size - 11][Math.floor(i / 3)] = bit
  }
  return modules
}

const masked = (mask, row, column) => [
  (row + column) % 2 === 0,
  row % 2 === 0,
  column % 3 === 0,
  (row + column) % 3 === 0,
  (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row * column) % 2 + (row * column) % 3 === 0,
  ((row * column) % 2 + (row * column) % 3) % 2 === 0,
  ((row * column) % 3 + (row + column) % 2) % 2 === 0,
][mask]

function addFormat(modules, mask) {
  const size = modules.length
  const data = (1 << 3) | mask // error correction level L
  const bits = ((data << 10) | bch(data, 0x537)) ^ 0x5412
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >>> i) & 1) === 1
    const verticalRow = i < 6 ? i : (i < 8 ? i + 1 : size - 15 + i)
    const horizontalColumn = i < 8 ? size - i - 1 : (i === 8 ? 7 : 15 - i - 1)
    modules[verticalRow][8] = bit
    modules[8][horizontalColumn] = bit
  }
  modules[size - 8][8] = true
}

function buildMatrix(codewords, mask, config) {
  const modules = baseMatrix(config)
  const size = modules.length
  addFormat(modules, mask)
  let row = size - 1
  let direction = -1
  let byte = 0
  let bit = 7
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column--
    while (true) {
      for (let side = 0; side < 2; side++) {
        const x = column - side
        if (modules[row][x] !== null) continue
        const dark = byte < codewords.length && ((codewords[byte] >>> bit) & 1) === 1
        modules[row][x] = masked(mask, row, x) ? !dark : dark
        if (--bit < 0) { byte++; bit = 7 }
      }
      row += direction
      if (row >= 0 && row < size) continue
      row -= direction
      direction = -direction
      break
    }
  }
  return modules
}

function penalty(matrix) {
  const size = matrix.length
  let score = 0
  for (let axis = 0; axis < 2; axis++) {
    for (let outer = 0; outer < size; outer++) {
      let run = 1
      let previous = axis ? matrix[0][outer] : matrix[outer][0]
      for (let inner = 1; inner < size; inner++) {
        const current = axis ? matrix[inner][outer] : matrix[outer][inner]
        if (current === previous) run++
        else { if (run >= 5) score += run - 2; run = 1; previous = current }
      }
      if (run >= 5) score += run - 2
    }
  }
  for (let row = 0; row < size - 1; row++) for (let column = 0; column < size - 1; column++) {
    const value = matrix[row][column]
    if (matrix[row + 1][column] === value && matrix[row][column + 1] === value && matrix[row + 1][column + 1] === value) score += 3
  }
  const finder = '10111010000'
  const reverse = '00001011101'
  for (let i = 0; i < size; i++) {
    const row = matrix[i].map(Number).join('')
    const column = matrix.map((line) => Number(line[i])).join('')
    for (const line of [row, column]) {
      for (let at = 0; at <= size - 11; at++) if ([finder, reverse].includes(line.slice(at, at + 11))) score += 40
    }
  }
  const dark = matrix.flat().filter(Boolean).length
  score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10
  return score
}

export function createQrMatrix(text) {
  const payload = new TextEncoder().encode(text)
  const config = CONFIGS.find((candidate) => payload.length <= candidate.dataBytes - 3)
  if (!config) throw new Error('The Pocket pairing code is too long to display')
  const codewords = encodePayload(payload, config)
  let matrix = null
  let best = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const candidate = buildMatrix(codewords, mask, config)
    const candidatePenalty = penalty(candidate)
    if (candidatePenalty < best) { best = candidatePenalty; matrix = candidate }
  }
  return matrix
}

export function createQrSvg(text) {
  const matrix = createQrMatrix(text)
  const size = matrix.length
  const quiet = 4
  const path = []
  for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
    if (matrix[row][column]) path.push(`M${column + quiet} ${row + quiet}h1v1h-1z`)
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${size + quiet * 2} ${size + quiet * 2}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'Scan to connect this phone to December')
  svg.setAttribute('shape-rendering', 'crispEdges')
  const background = document.createElementNS(svg.namespaceURI, 'rect')
  background.setAttribute('width', '100%')
  background.setAttribute('height', '100%')
  background.setAttribute('fill', '#fff')
  const modules = document.createElementNS(svg.namespaceURI, 'path')
  modules.setAttribute('d', path.join(''))
  modules.setAttribute('fill', '#171613')
  svg.append(background, modules)
  return svg
}
