// Adapted from December Relay 9b0a352, public/app.mjs. Runs only while work is pending.
const WIND_BOX = 24;

// Drawn marks run on twos: 12 held poses a second inside 24fps playback.
const onTwos = (ms) => `steps(${Math.max(1, Math.round(ms / (1000 / 12)))}, end)`;

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
    line.setAttribute('stroke-dasharray', total)
    run(svg, svg, [{opacity:0,transform:'scale(.7)'},{opacity:1,transform:'scale(1)'}],
      {duration:300,delay:110,easing:onTwos(300),fill:'backwards'})
    const wound = run(svg,line,[{strokeDashoffset:total},{strokeDashoffset:0}],
      {duration:460,delay:110,easing:onTwos(460),fill:'both'})
    wound.addEventListener('finish', () => {
      if (!svg.isConnected || !active.has(svg)) return
      // Release the entrance before the chase takes ownership of the path.
      wound.cancel()
      active.get(svg).delete(wound)
      line.setAttribute('stroke-dasharray', `${lit} ${total-lit}`)
      run(svg,line,[{strokeDashoffset:0},{strokeDashoffset:-total}],
        {duration:3200,iterations:Infinity,easing:onTwos(3200)})
    }, {once:true})
  })
  return svg
}
function unwind(mark) {
  if (!mark || mark.dataset.unwinding) return
  stopWind(mark, false)
  if (reducedMotion() || !mark.isConnected) return mark.remove()
  mark.dataset.unwinding = 'true'
  active.set(mark,new Set())
  const line = mark.querySelector('.wind-thread'), total = line.getTotalLength()
  line.setAttribute('stroke-dasharray', total)
  run(mark,line,[{strokeDashoffset:0},{strokeDashoffset:total}],{duration:260,easing:onTwos(260),fill:'forwards'})
  const out = run(mark,mark,[{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.82)'}],{duration:260,easing:onTwos(260),fill:'forwards'})
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
