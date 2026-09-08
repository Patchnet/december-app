// Native details semantics, with a short, interruptible height transition.
// Only the existing media-list disclosure opts in; no content is removed.
const running = new Map()
const preference=matchMedia('(prefers-reduced-motion: reduce)')
function finish(fold,current) {
  if(running.get(fold)!==current)return
  current.animation.onfinish=null
  current.animation.cancel()
  if(fold.isConnected)fold.open=current.opening
  fold.style.overflow=''
  running.delete(fold)
}
function finishAll(){for(const [fold,current] of running)finish(fold,current)}
preference.addEventListener?.('change',()=>{if(preference.matches)finishAll()})
document.addEventListener('visibilitychange',()=>{if(document.hidden)finishAll()})
document.addEventListener('click', (event) => {
  const summary = event.target.closest?.('.list-preview > summary')
  if (!summary) return
  const fold = summary.parentElement
  if (preference.matches || !fold.animate) return
  event.preventDefault()
  const previous = running.get(fold)
  const opening = previous ? !previous.opening : !fold.open
  const from = fold.getBoundingClientRect().height
  if (previous) { previous.animation.onfinish = null; previous.animation.cancel() }
  fold.open = true
  const to = opening ? fold.scrollHeight : summary.getBoundingClientRect().height
  fold.style.overflow = 'hidden'
  const animation = fold.animate([{height:`${from}px`},{height:`${to}px`}], {
    duration:260, easing:'cubic-bezier(.22,1,.36,1)', fill:'both',
  })
  const current={animation,opening}
  running.set(fold,current)
  animation.onfinish=()=>finish(fold,current)
})
