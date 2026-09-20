// Adapted from December Relay 9b0a352, public/app.mjs. Runs only while work is pending.
const WIND_BOX = 24;

function windPath({ turns = 3, steps = 160, inset = 2.2 } = {}) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2 * turns;
    points.push([Math.cos(t) + 0.5 * Math.cos(5.3 * t), Math.sin(t) + 0.5 * Math.sin(4.7 * t)]);
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = (WIND_BOX - inset * 2) / Math.max(maxX - minX, maxY - minY);
  const ox = (WIND_BOX - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (WIND_BOX - (maxY - minY) * scale) / 2 - minY * scale;
  return 'M' + points.map(([x, y]) => `${(x * scale + ox).toFixed(1)} ${(y * scale + oy).toFixed(1)}`).join('L');
}

let woundPath = null
const active = new Map()
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
function run(mark, node, frames, options) {
  const animation = node.animate(frames, options)
  active.get(mark)?.add(animation)
  if (document.hidden) animation.pause()
  return animation
}
function stopWind(mark, remove = true) {
  for (const animation of active.get(mark) || []) animation.cancel()
  active.delete(mark)
  if (remove) mark?.remove()
}
function windMark() {
  woundPath ??= windPath()
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${WIND_BOX} ${WIND_BOX}`)
  svg.setAttribute('class', 'wind')
  svg.setAttribute('aria-hidden', 'true')
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  line.setAttribute('d', woundPath)
  line.setAttribute('class', 'wind-thread')
  const underlay = line.cloneNode()
  underlay.setAttribute('class', 'wind-underlay')
  svg.append(underlay, line)
  active.set(svg, new Set())
  if (reducedMotion()) return svg
  requestAnimationFrame(() => {
    if (!svg.isConnected || !active.has(svg)) return stopWind(svg)
    const total = line.getTotalLength(), lit = total * .14
    // Start the continuous chase immediately. No stepped poses or switch
    // from a fully drawn path to a short segment at the end of an entrance.
    line.setAttribute('stroke-dasharray', `${lit} ${total-lit}`)
    run(svg, svg, [{opacity:.65,transform:'scale(.96)'},{opacity:1,transform:'scale(1)'}],
      {duration:360,easing:'cubic-bezier(.32,.08,.2,1)',fill:'backwards'})
    run(svg,line,[{strokeDashoffset:0},{strokeDashoffset:-total}],
      {duration:4000,iterations:Infinity,easing:'linear'})
  })
  return svg
}
function unwind(mark) {
  if (!mark || mark.dataset.unwinding) return
  const line = mark.querySelector('.wind-thread')
  const visible = getComputedStyle(mark), thread = getComputedStyle(line)
  const opacity = visible.opacity, transform = visible.transform
  const offset = parseFloat(thread.strokeDashoffset) || 0
  stopWind(mark, false)
  if (reducedMotion() || !mark.isConnected) return mark.remove()
  mark.dataset.unwinding = 'true'
  active.set(mark,new Set())
  const total = line.getTotalLength()
  run(mark,line,[{strokeDashoffset:offset},{strokeDashoffset:offset-total*.1}],{duration:400,easing:'linear',fill:'forwards'})
  const out = run(mark,mark,[{opacity,transform},{opacity:0,transform:'scale(.94)'}],{duration:400,easing:'cubic-bezier(.32,.08,.2,1)',fill:'forwards'})
  out.addEventListener('finish',()=>stopWind(mark),{once:true})
}
document.addEventListener('visibilitychange',()=>{
  for (const [mark,animations] of active) {
    if (!mark.isConnected) { stopWind(mark); continue }
    for (const animation of animations) {
      if (document.hidden) animation.pause()
      else if (animation.playState === 'paused') animation.play()
    }
  }
})
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', event => {
  if (!event.matches) return
  for (const mark of [...active.keys()]) {
    if (mark.dataset.unwinding) { stopWind(mark); continue }
    stopWind(mark, false)
    mark.querySelector('.wind-thread')?.setAttribute('stroke-dasharray', 'none')
  }
})
export { windMark, unwind, stopWind }
