import { windMark, unwind, stopWind } from './working-mark.js'
const states = new WeakMap()
let dialog, owner, returnTo

function refreshQueue(state) {
  if (!dialog?.open || owner !== state) return
  const list = dialog.querySelector('ol')
  const old = new Map([...list.children].map(row=>[row.dataset.id,row]))
  const keep = new Set()
  state.queue.forEach((entry,index)=>{
    let row = old.get(entry.id)
    if (!row) {
      row = document.createElement('li')
      row.dataset.id = entry.id
      row.innerHTML = '<span class="pending-note"></span><span class="pending-detail"></span>'
    }
    row.querySelector('.pending-note').textContent = entry.text
    row.querySelector('.pending-detail').textContent = [entry.hint,entry.status].filter(Boolean).join(' · ')
    row.classList.toggle('needs-retry',!!entry.error || entry.status === 'Waiting for retry')
    if (list.children[index] !== row) list.insertBefore(row,list.children[index] || null)
    keep.add(row)
  })
  for (const row of [...list.children]) if (!keep.has(row)) row.remove()
  dialog.querySelector('.pending-summary').textContent = state.queue.length
    ? `${state.queue.length} ${state.queue.length === 1 ? 'note' : 'notes'}`
    : 'Nothing left in the queue.'
  const retry = dialog.querySelector('.retry')
  retry.hidden = !state.retryLocal && !state.retryAgent
  retry.textContent = state.retryLocal ? 'Retry sending' : 'Retry remaining notes'
}
function showQueue(state) {
  if (!dialog) {
    dialog = document.createElement('dialog')
    dialog.className = 'pending-dialog'
    dialog.setAttribute('aria-labelledby','pending-title')
    dialog.innerHTML = '<div class="surface-heading"><h2 id="pending-title">Waiting to be filed</h2><button type="button" class="surface-close">Close</button></div><p class="pending-summary" role="status"></p><ol></ol><button type="button" class="retry" hidden>Retry</button>'
    dialog.querySelector('.surface-close').onclick = () => dialog.close()
    dialog.addEventListener('click', event => {
      const rect = dialog.getBoundingClientRect()
      if(event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close()
    })
    dialog.addEventListener('close',()=>{(returnTo?.isConnected && !returnTo.disabled && !returnTo.closest('[hidden], [inert]') ? returnTo : document.querySelector('#stage[data-mode=asking] .ask-input, #stage:not([data-mode=asking]) #capture'))?.focus({preventScroll:true});owner=null})
    document.body.append(dialog)
  }
  owner = state
  returnTo = document.activeElement
  dialog.showModal()
  refreshQueue(state)
}

// where the sentence comes from when it was not typed: a chosen chip
// hands its own place to the settling row, so the words travel from the
// chip, not from the empty line
let origin = null
export function settleFrom(rect) { origin = { rect, at: Date.now() } }

export function renderPendingStage(box, {queue = [], show = false, mode = 'working', retryLocal = false, retryAgent = false} = {}) {
  let state = states.get(box)
  if (!state) {
    box.innerHTML = '<button type="button" class="pending-lines" aria-haspopup="dialog"><span class="pending-previous" aria-hidden="true"></span><span class="working"><span class="working-word"></span><span class="pending-more" aria-hidden="true"></span><span class="pending-compact-label" aria-hidden="true"></span></span></button><div class="pending-meta"><span role="status" aria-live="polite"></span><button type="button" class="retry" hidden>retry</button></div>'
    state = {queue:[],mode:null,lines:box.querySelector('.pending-lines'),row:box.querySelector('.working'),previous:box.querySelector('.pending-previous'),word:box.querySelector('.working-word'),more:box.querySelector('.pending-more'),compact:box.querySelector('.pending-compact-label'),status:box.querySelector('[role="status"]'),retry:box.querySelector('.retry')}
    state.lines.addEventListener('click',()=>showQueue(state))
    states.set(box,state)
  }
  // One sentence enters once. Its id is renamed retaining → local → server
  // on the way, and an older note becomes the front line when a newer one
  // files; neither is a new sentence, so entrances are keyed on the words.
  const line = document.querySelector('#capture')
  const newest = queue.at(-1)?.text || ''
  // still sitting in the line: the yarn starts now, the words wait to leave
  const held = !!newest && !state.seen?.has(newest) && line?.value.trim() === newest
  const lines = held ? queue.slice(0,-1) : queue
  const text = lines.at(-1)?.text || ''
  const changed = !!text && !state.seen?.has(text)
  state.seen = new Set(lines.map(entry=>entry.text))
  Object.assign(state,{queue,mode,retryLocal,retryAgent})
  refreshQueue(state)
  box.hidden = !show
  if (!show) {
    state.row.querySelectorAll('.wind').forEach(mark=>stopWind(mark))
    return
  }
  state.previous.textContent = lines.length > 1 ? lines.at(-2).text : ''
  state.previous.hidden = lines.length < 2
  // with nothing left to read, the yarn alone says the last change is landing
  state.word.textContent = text
  state.lines.disabled = !queue.length
  state.lines.setAttribute('aria-label',`View ${queue.length} pending ${queue.length === 1 ? 'note' : 'notes'}`)
  const label = mode === 'retaining' ? 'Keeping your note' : mode === 'send-failed' ? 'Not sent yet · saved here' : mode === 'sending' ? 'Saved here · waiting to send' : mode === 'failed' ? 'Some notes still need filing' : mode === 'saved' ? 'Saved in December' : mode === 'waiting' ? 'Waiting to be filed' : mode === 'filing' ? 'Putting changes in place' : 'December is working'
  const status = `${label}${queue.length ? ` · ${queue.length} ${queue.length === 1 ? 'note' : 'notes'}` : ''}${mode === 'working' && retryLocal ? ' · some notes not sent' : ''}`
  if (state.status.textContent !== status) state.status.textContent = status
  state.compact.textContent = status
  // how many more wait behind this one — a number, not a sentence
  state.more.textContent = queue.length > 1 ? `${queue.length - 1} more` : ''
  state.retry.hidden = !retryAgent && !retryLocal
  state.retry.textContent = retryLocal ? 'retry sending' : 'retry'
  const active = ['retaining', 'sending', 'waiting', 'working', 'filing'].includes(mode)
  state.row.classList.toggle('alive', active)
  const mark = state.row.querySelector('.wind')
  if (active) {
    if (mark?.dataset.unwinding) stopWind(mark)
    if (!state.row.querySelector('.wind')) state.row.prepend(windMark())
  } else if (mark) unwind(mark)
  if (changed && !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state.word.getAnimations().forEach(animation=>animation.cancel())
    // the sentence you just wrote comes DOWN from the line, at the line's
    // size, and settles into its smaller place: one thing moving, not one
    // thing vanishing and another appearing
    const chip = origin && Date.now() - origin.at < 2000 ? origin.rect : null
    origin = null
    const queuedAt = performance.now()
    requestAnimationFrame(() => {
      // Measure after renderStage has selected its final, fixed-slot layout.
      if (box.hidden || document.hidden || performance.now() - queuedAt > 150 || state.word.textContent !== text || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const from = chip || (line && line.getBoundingClientRect()), to = state.word.getBoundingClientRect()
      // ask the line itself: the stage's mode is only repainted after this render,
      // and a line holding other words is not where this sentence comes from
      const fromLine = from && to.height && (chip || !line.value.trim())
      const dy = fromLine ? Math.round(from.top - to.top) : 7
      const scale = chip ? 1 : fromLine ? Math.min(1.35, 17 / 13) : 1
      state.word.style.transformOrigin = 'left top'
      state.word.animate(
        fromLine
          ? [{opacity:.9,transform:`translateY(${dy}px) scale(${scale})`,filter:'blur(0)'},{opacity:1,transform:'none',filter:'blur(0)'}]
          : [{opacity:0,transform:'translateY(7px)',filter:'blur(3px)'},{opacity:1,transform:'none',filter:'blur(0)'}],
        {duration:180,easing:'cubic-bezier(.32,.08,.2,1)'}
      )
    })
  }
}
