// Reveal real provisional text without changing its layout, DOM, or save state.
// Range rectangles follow wrapping; grapheme boundaries keep emoji intact.
const live = new Map()
const preference = matchMedia('(prefers-reduced-motion: reduce)')
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const selector = '.space-name, .row-text, .note-text, .solo-text'

function clear(entry) {
  entry.el.style.clipPath = entry.saved
}
export function finishCardWriting(card) {
  const state = live.get(card)
  if (!state) return
  live.delete(card)
  cancelAnimationFrame(state.frame)
  for (const entry of state.entries.values()) clear(entry)
}
function reveal(entry, count) {
  if (!count) { entry.el.style.clipPath = 'inset(0 100% 0 0)'; return }
  if (count >= entry.ends.length) { clear(entry); return }
  let remaining = entry.ends[count - 1]
  const walker = document.createTreeWalker(entry.el, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  range.setStart(entry.el, 0)
  let node
  while ((node = walker.nextNode())) {
    if (remaining <= node.length) { range.setEnd(node, remaining); break }
    remaining -= node.length
  }
  if (!node) { clear(entry); return }
  const box = entry.el.getBoundingClientRect()
  const paths = [...range.getClientRects()].filter(r => r.width && r.height).map(r => {
    const x = r.left - box.left - 1, y = r.top - box.top - 1
    return `M${x},${y}h${r.width + 2}v${r.height + 2}h-${r.width + 2}Z`
  })
  entry.el.style.clipPath = `path('${paths.join(' ')}')`
}
export function syncCardWriting(card) {
  if (!card?.classList.contains('building') || preference.matches || document.hidden) { finishCardWriting(card); return }
  let state = live.get(card)
  if (!state) { state = { entries: new Map(), frame: 0 }; live.set(card, state) }
  const nodes = [...card.querySelectorAll(selector)]
  for (const [el, entry] of state.entries) if (!nodes.includes(el)) { clear(entry); state.entries.delete(el) }
  const now = performance.now()
  nodes.forEach((el, i) => {
    const text = el.textContent || ''
    const old = state.entries.get(el)
    if (old?.text === text) return
    const ends = [...segmenter.segment(text)].map(s => s.index + s.segment.length)
    // Appended text continues from the already visible prefix.
    const prefix = old && text.startsWith(old.text) ? Math.min(old.shown, ends.length) : 0
    const entry = { el, text, ends, shown: prefix, from: prefix, saved: old ? old.saved : el.style.clipPath, start: now + Math.min(i * 65, 240), duration: Math.min(1100, Math.max(400, (ends.length - prefix) * 18)) }
    state.entries.set(el, entry)
    reveal(entry, prefix)
  })
  cancelAnimationFrame(state.frame)
  function tick(now) {
    if (!card.isConnected || !card.classList.contains('building') || preference.matches || document.hidden) { finishCardWriting(card); return }
    let pending = false
    for (const entry of state.entries.values()) {
      const p = Math.max(0, Math.min(1, (now - entry.start) / entry.duration))
      const ease = p * p * (3 - 2 * p)
      entry.shown = entry.from + Math.floor((entry.ends.length - entry.from) * ease)
      reveal(entry, entry.shown)
      if (p < 1) pending = true
    }
    state.frame = pending ? requestAnimationFrame(tick) : 0
  }
  state.frame = requestAnimationFrame(tick)
}
preference.addEventListener('change', () => { if (preference.matches) for (const card of live.keys()) finishCardWriting(card) })
document.addEventListener('visibilitychange', () => { if (document.hidden) for (const card of live.keys()) finishCardWriting(card) })
