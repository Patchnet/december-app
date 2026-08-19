import { reduced } from './session.js'

// ------------------------------------------------------------ the receipt
// Provenance, in the page's own hand. Rows and entries carry the words
// they came from in data-src; the browser's native tooltip showed them in
// the OS's chrome, which is the one voice this page never speaks in. One
// quiet card, below the row, after the same beat a tooltip would take.

let tip = null
let showT = null
let on = null // the element currently owning the receipt

function ensure() {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'receipt'
  tip.setAttribute('aria-hidden', 'true')
  document.body.appendChild(tip)
  return tip
}

function show(el) {
  const t = ensure()
  t.textContent = `from: ${el.dataset.src}`
  const r = el.getBoundingClientRect()
  t.style.left = '0px'
  t.style.top = '0px'
  t.classList.add('on')
  // measure after content, then clamp inside the viewport
  const w = t.offsetWidth
  const x = Math.max(8, Math.min(r.left + 26, innerWidth - w - 8))
  const below = r.bottom + 6 + t.offsetHeight < innerHeight
  t.style.left = `${x}px`
  t.style.top = `${below ? r.bottom + 6 : r.top - t.offsetHeight - 6}px`
  on = el
}

function hide() {
  clearTimeout(showT)
  showT = null
  on = null
  tip?.classList.remove('on')
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[data-src]')
  if (el === on) return
  hide()
  if (!el || !el.dataset.src) return
  showT = setTimeout(() => show(el), 550)
})
document.addEventListener('mouseout', (e) => {
  if (e.target.closest?.('[data-src]')) hide()
})
// the words behind a row do not need to follow it around
document.addEventListener('scroll', hide, true)
document.addEventListener('click', hide, true)
if (reduced) document.addEventListener('mousedown', hide)
