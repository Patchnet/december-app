// Local developer setup. The key is never echoed or sent anywhere here.
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { emitKeypressEvents } from 'node:readline'
const directory = fileURLToPath(new URL('../data/credentials/', import.meta.url))
const file = fileURLToPath(new URL('../data/credentials/typesafe.key', import.meta.url))
if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal, or set TYPESAFE_API_KEY_FILE to your own private file.')
emitKeypressEvents(process.stdin)
process.stdin.setRawMode(true)
process.stdout.write('Paste your own TypeSafe API key (hidden), then Enter: ')
let value = ''
const key = await new Promise((resolve, reject) => {
  const listen = (text, event = {}) => {
    if (event.ctrl && event.name === 'c') { cleanup(); reject(new Error('Cancelled')); return }
    if (event.name === 'return' || event.name === 'enter') { cleanup(); resolve(value.trim()); return }
    if (event.name === 'backspace') { value = value.slice(0, -1); return }
    if (text && !event.ctrl && !event.meta) value += text.replace(/[\r\n]/g, '')
  }
  const cleanup = () => { process.stdin.off('keypress', listen); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n') }
  process.stdin.on('keypress', listen)
})
if (!key) throw new Error('No key entered; nothing saved.')
await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
await writeFile(file, key + '\n', { mode: 0o600, flag: 'wx' })
await chmod(file, 0o600)
console.log('Saved locally in ignored data/credentials/typesafe.key. Existing keys are never overwritten. Run npm run preview:jev.')
