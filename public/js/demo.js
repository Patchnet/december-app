import { $, page } from './session.js'
import { shouldOnboard } from './connections.js'

// ----------------------------------------------------- the first-run demo
// Once, on a truly empty page: the page performs its own pitch, then
// hands you the pen. Any key or click skips it.

async function firstRunDemo() {
  // neither an onboarding run nor a year with carryover waiting gets the demo
  if (shouldOnboard || localStorage.getItem('dec-demo') || page.state.spaces.length || page.state.captures.length || page.state.carryover) return
  localStorage.setItem('dec-demo', '1') // once, ever — even if it is cut short
  let alive = true
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // the field is driven the way a person drives it, so the stage clears
  // itself while the sentence is being written, exactly as it will for you
  const put = (v) => {
    page.field.value = v
    page.field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const stop = () => {
    if (!alive) return
    alive = false
    put('')
    document.querySelector('.demo-card')?.remove()
    page.field.focus()
  }
  window.addEventListener('keydown', stop, { once: true })
  window.addEventListener('mousedown', stop, { once: true })

  await wait(600)
  if (!alive) return
  for (const ch of 'paid rent this month, $2300') {
    if (!alive) return
    put(page.field.value + ch)
    await wait(38)
  }
  await wait(480)
  if (!alive) return

  // the sentence becomes the card: it lands in the column a real one would,
  // and rises with the same entrance every real card uses
  put('')
  const card = document.createElement('article')
  card.className = 'space fresh demo-card'
  card.innerHTML = `
    <h2 class="space-name">Housing</h2>
    <div class="block hero">
      <div class="block-title">Rent</div>
      <div class="ledger-total">$2,300</div>
      <div class="ledger-entry"><span>This month's rent</span><span>$2,300</span></div>
    </div>`
  ;($('#spaces .col') || $('#spaces')).appendChild(card)
  await wait(2100)
  if (!alive) return
  card.classList.add('ghost-out')
  await wait(380)
  card.remove()
  alive = false
  page.field.focus()
}
export { firstRunDemo }
