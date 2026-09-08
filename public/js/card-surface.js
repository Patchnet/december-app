import { heroId } from './blocks.js'

/** Pinning does not change a space's content, so its updatedAt does not
    move and the card's markup is never rebuilt. The tools have to be synced
    on their own or an unpinned card keeps a solid pin forever. */
export function syncTools(el, space) {
  if (!el) return
  el.dataset.kind = space.blocks.find((b) => b.id === heroId(space))?.type || space.blocks[0]?.type || 'note'
  el.classList.toggle('pinned', !!space.pinned)
  const pin = el.querySelector('[data-pin]')
  if (pin) {
    pin.classList.toggle('on', !!space.pinned)
    pin.setAttribute('aria-label', space.pinned ? 'Unpin' : 'Pin')
    pin.setAttribute('title', space.pinned ? 'unpin' : 'pin')
    pin.querySelector('svg')?.setAttribute('fill', space.pinned ? 'currentColor' : 'none')
  }
  const finish = el.querySelector('[data-finish]')
  if (finish) {
    finish.classList.toggle('ready', !space.finished && space.role === 'do' && !!space.complete)
    finish.setAttribute('aria-label', space.finished ? 'Reopen this space' : 'Archive this space')
    finish.setAttribute('title', space.finished ? 'reopen' : 'archive')
  }
}

/** Detail surfaces keep keyboard navigation within the thing being read. */
export function mountSurface(card, focusClose = false) {
  if (!card) return
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', card.querySelector('.space-name')?.textContent || 'December detail')
  document.documentElement.classList.add('modal-open')
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    const items = [...card.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(el => el.getClientRects().length && !el.closest('[hidden]'))
    if (!items.length) return
    const first = items[0], last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  })
  if (focusClose) card.querySelector('[data-close]')?.focus({preventScroll:true})
}
