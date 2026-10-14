// A detail is the same card at a different scale, not an unrelated sheet.
// One owner per surface; interrupt from displayed geometry before cancelling.
import { finishCardShape } from './card-shape.js'
const preference = matchMedia('(prefers-reduced-motion: reduce)')
const moving = new Map()
const exits = new Set()
let returning = null
const ease = 'cubic-bezier(.22,.61,.36,1)'
const visible = r => r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
export function rectFrame(from, to, radius = 18) {
  const scale = Math.max(from.width / to.width, from.height / to.height)
  return {
    transform: `translate(${from.left-to.left}px, ${from.top-to.top}px) scale(${scale})`,
    clipPath: `inset(0px ${Math.max(0,to.width-from.width/scale)}px ${Math.max(0,to.height-from.height/scale)}px 0px round ${radius/scale}px)`,
  }
}
export function focusVisualRect(card) {
  if (!card) return null
  const r = card.getBoundingClientRect()
  const style = getComputedStyle(card)
  const clip = /^inset\(([^r)]+)/.exec(style.clipPath)?.[1].trim().split(/\s+/).map(parseFloat)
  const scale = new DOMMatrixReadOnly(style.transform).a
  const width = r.width - (clip ? (clip[1] ?? clip[0])*scale : 0)
  const height = r.height - (clip ? (clip[2] ?? clip[0])*scale : 0)
  return {left:r.left,top:r.top,width,height,right:r.left+width,bottom:r.top+height}
}
export function focusIsMoving(card) { return moving.has(card) }

// The page going out of focus behind the card is the same move as the card:
// tint and blur radius travel together, on the card's clock. What is on
// screen is read back as {opacity, filter}, so an interrupt continues from it.
const clear = {opacity: 0, filter: 'blur(0px)'}
const backdropOf = card => {
  const el = card.parentElement?.previousElementSibling
  return el?.matches('.focus-backdrop') ? el : null
}
const backdropFrame = ({opacity, filter}) => ({opacity, backdropFilter: filter, webkitBackdropFilter: filter})
export function backdropVisual(backdrop) {
  if (!backdrop?.isConnected) return null
  const style = getComputedStyle(backdrop)
  const filter = style.backdropFilter || style.webkitBackdropFilter
  return {opacity: style.opacity, filter: filter && filter !== 'none' ? filter : 'blur(0px)'}
}

function stop(card) {
  const current = moving.get(card)
  if (!current) return
  moving.delete(card)
  card.classList.remove('spatial-moving')
  cancelAnimationFrame(current.frame)
  current.animation.cancel()
  current.backdrop?.cancel()
  for (const animation of current.ink) animation.cancel()
}
export function finishFocusExits() { for (const finish of [...exits]) finish() }

export function openFocusMotion(card, origin, backdropFrom) {
  if (!card) return
  if (returning?.card.dataset.sid === card.dataset.sid) origin = focusVisualRect(returning.card)
  // One backdrop on screen, whoever holds it: a retarget continues its own,
  // a surface replaced in place hands its over, and a reopen takes the
  // leaving ghost's before that ghost is dropped. Only a cold open is clear.
  const backdrop = backdropOf(card)
  backdropFrom = (moving.has(card) && backdropVisual(backdrop)) || backdropFrom || backdropVisual(returning?.backdrop) || clear
  finishFocusExits()
  const inkFrom = [...card.children].map(el => moving.has(card) ? getComputedStyle(el).opacity : .15)
  stop(card)
  finishCardShape(card)
  card.classList.add('spatial-focus')
  // from here the CSS fade is off; with no motion the backdrop simply rests
  backdrop?.classList.add('spatial-backdrop')
  if (preference.matches || document.hidden) return
  const target = card.getBoundingClientRect()
  if (!target.width || !target.height) return
  card.classList.add('spatial-moving')
  if (!visible(origin)) origin = {left:target.left, top:target.top+8, width:target.width, height:target.height}
  const animation = card.animate([
    rectFrame(origin, target),
    { transform: 'none', clipPath: `inset(0px 0px 0px 0px round ${getComputedStyle(card).borderRadius})` },
  ], { duration: 300, easing: ease, fill: 'both' })
  // One keyframe: the end is whatever the stylesheet rests at, so the theme
  // and an engine without backdrop-filter both land on their own value.
  const backdropAnimation = backdrop?.animate([
    { ...backdropFrame(backdropFrom), offset: 0 },
  ], { duration: 300, easing: ease, fill: 'both' })
  // The expanded content resolves as the frame opens. It stays interactive
  // throughout; there is no timer before typing, closing, or saving works.
  const ink = [...card.children].map((el, i) => el.animate([
    { opacity: inkFrom[i] }, { opacity: 1 },
  ], { duration: 180, easing: 'ease-out', fill: 'both' }))
  const current = {animation, ink, backdrop: backdropAnimation, visual: origin, frame: 0}
  moving.set(card, current)
  const track = () => {
    if (moving.get(card) !== current) return
    current.visual = focusVisualRect(card)
    current.frame = requestAnimationFrame(track)
  }
  current.frame = requestAnimationFrame(track)
  animation.onfinish = () => { if (moving.get(card)?.animation === animation) stop(card) }
}

// `backdropFrom` is the backdrop as it was displayed before it moved into the
// ghost: the move drops a CSS fade still in progress, so afterwards is too late.
export function leaveFocusMotion(ghost, from, destination, {instant = false, backdropFrom} = {}) {
  const card = ghost.querySelector('.focus-card')
  const backdrop = ghost.querySelector('.focus-backdrop')
  backdropFrom ||= backdropVisual(backdrop)
  const ink = card ? [...card.children].map(el => ({el, opacity:getComputedStyle(el).opacity})) : []
  if (card) stop(card)
  if (card) finishCardShape(card)
  if (!card || instant || preference.matches || document.hidden) { ghost.remove(); return }
  card.classList.add('spatial-focus')
  card.classList.add('spatial-moving')
  const base = card.getBoundingClientRect()
  const hasDestination = visible(destination)
  const end = hasDestination ? rectFrame(destination, base) : {transform:'translateY(8px) scale(.985)', clipPath:'inset(0px 0px 0px 0px round 26px)'}
  const duration = hasDestination ? 220 : 160
  for (const {el, opacity} of ink) el.animate([{opacity},{opacity:0}], {duration:duration*.8,fill:'both'})
  const animation = card.animate([
    { ...rectFrame(from || base, base, 26), opacity: 1, offset: 0 },
    { ...end, opacity: hasDestination ? .9 : 0, offset: .88 },
    { ...end, opacity: 0, offset: 1 },
  ], {duration, easing: ease, fill: 'both'})
  // the page comes back into focus as the card lands, not ahead of it
  if (backdrop && backdropFrom) backdrop.animate([backdropFrame(backdropFrom), backdropFrame(clear)], {duration, easing: ease, fill:'both'})
  let timer
  const finish = () => {
    clearTimeout(timer); exits.delete(finish); animation.cancel(); ghost.remove()
    if (returning?.card === card) returning = null
  }
  returning = {card, backdrop}
  exits.add(finish)
  animation.onfinish = finish
  timer = setTimeout(finish, duration+80)
}

function settle() {
  for (const card of [...moving.keys()]) stop(card)
  finishFocusExits()
}
preference.addEventListener('change', () => { if (preference.matches) settle() })
document.addEventListener('visibilitychange', () => { if (document.hidden) settle() })

// Retarget from the last painted frame, never from a stale viewport endpoint.
window.addEventListener('resize', () => {
  finishFocusExits()
  for (const [card, current] of [...moving]) openFocusMotion(card, current.visual)
})
