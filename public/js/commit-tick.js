// Approved original a10 p5.brush check: eight drawings, then the static tick.
// No filing state or timers depend on the decorative image loading.
const active = new WeakMap(), cleanups = new Set()
let ready = false
const image = new Image()
image.src = new URL('../brush/commit-tick.png', import.meta.url).href
image.decode().then(() => {
  ready = true
  document.documentElement.classList.add('painted-ticks')
}).catch(() => {})

const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
const clearAll = () => { for (const cleanup of [...cleanups]) cleanup() }
document.addEventListener('visibilitychange', () => { if (document.hidden) clearAll() })
preference.addEventListener('change', () => { if (preference.matches) clearAll() })

export function clearCommitTick(row) { active.get(row)?.() }

export function commitTick(row) {
  clearCommitTick(row)
  const tick = row?.querySelector('.tick')
  if (!tick?.isConnected || !row.classList.contains('done') || !ready || preference.matches || document.hidden) return
  const r = tick.getBoundingClientRect()
  if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) return
  const plate = document.createElement('span')
  plate.className = 'commit-tick-live'
  plate.setAttribute('aria-hidden','true')
  tick.appendChild(plate)
  row.classList.add('commit-playing')
  const animation = plate.animate([{backgroundPosition:'0% 0'},{backgroundPosition:'63.6363636% 0'}],{duration:583,easing:'steps(7,end)',fill:'forwards'})
  const cleanup = () => {
    clearTimeout(timer)
    animation.cancel()
    plate.remove()
    row.classList.remove('commit-playing')
    cleanups.delete(cleanup)
    if (active.get(row) === cleanup) active.delete(row)
  }
  const timer = setTimeout(cleanup,680)
  active.set(row,cleanup)
  cleanups.add(cleanup)
}
