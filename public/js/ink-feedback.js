// Drawn accents inspired by December's film and Patchnet Design's overlays.
// They are local to the changed text, finite, and own no application state.
const active = new WeakMap()
const NS = 'http://www.w3.org/2000/svg'

export function clearInk(el) {
  active.get(el)?.()
}

function mountInk(el, paths, width, height, kind) {
  clearInk(el)
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('preserveAspectRatio','none')
  svg.setAttribute('aria-hidden','true')
  svg.setAttribute('focusable','false')
  svg.setAttribute('class',`ink-feedback ink-${kind}`)
  for (const d of paths) {
    const path = document.createElementNS(NS,'path')
    path.setAttribute('d',d)
    path.setAttribute('pathLength','1')
    svg.appendChild(path)
  }
  el.classList.add('ink-host',`ink-${kind}-active`)
  el.appendChild(svg)
  const cleanup = () => {
    clearTimeout(timer)
    observer?.disconnect()
    svg.remove()
    el.classList.remove(`ink-${kind}-active`)
    if (active.get(el) === cleanup) active.delete(el)
  }
  // Reflow ends the accent rather than letting a drawn line drift off its text.
  const original = el.getBoundingClientRect()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    const box = el.getBoundingClientRect()
    if (Math.abs(box.width-original.width)>1 || Math.abs(box.height-original.height)>1) cleanup()
  })
  const timer = setTimeout(cleanup,kind === 'strike' ? 650 : 1500)
  observer?.observe(el)
  active.set(el,cleanup)
}

function visible(el) {
  if (!el?.isConnected || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  const r = el.getBoundingClientRect()
  return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth
}

/** Coalesce link/text fragments on the same printed line. */
export function inkLines(rects, origin) {
  const lines=[]
  for (const r of rects) {
    if (r.width<1 || r.height<1) continue
    const y=r.top+r.height*.52-origin.top
    const existing=lines.find(line=>Math.abs(line.y-y)<3)
    const left=r.left-origin.left,right=r.right-origin.left
    if (existing) { existing.left=Math.min(existing.left,left); existing.right=Math.max(existing.right,right) }
    else lines.push({left,right,y})
  }
  return lines
}

export function drawCompletion(row) {
  const el=row?.querySelector('.row-text')
  if (!row?.classList.contains('done') || !visible(el)) return
  clearInk(el)
  const box=el.getBoundingClientRect(),range=document.createRange()
  range.selectNodeContents(el)
  const lines=inkLines([...range.getClientRects()],box)
  const paths=lines.map(({left,right,y})=>{
    const width=right-left
    return `M${left} ${y+.3} Q${left+width*.35} ${y-1} ${left+width*.62} ${y+.2} T${right} ${y-.3}`
  })
  if (paths.length) mountInk(el,paths,box.width,box.height,'strike')
}

/** The film's imperfect, slightly overshooting pen ring, fitted to a number. */
export function circleNumber(container) {
  const el=container?.querySelector('b') || container
  if (!visible(el)) return
  const box=el.getBoundingClientRect(),w=box.width,h=box.height
  // A ledger's block box spans the card. Its first text node is the actual value.
  const range=document.createRange()
  if (!el.firstChild) return
  range.selectNode(el.firstChild)
  const value=range.getBoundingClientRect()
  const rx=(value.width+10)/2, ry=(value.height+7)/2
  const cx=value.left-box.left+value.width/2,cy=value.top-box.top+value.height/2
  const path=`M${cx+rx} ${cy} C${cx+rx} ${cy-ry*.74} ${cx+rx*.62} ${cy-ry} ${cx} ${cy-ry} C${cx-rx*.66} ${cy-ry} ${cx-rx} ${cy-ry*.72} ${cx-rx} ${cy} C${cx-rx} ${cy+ry*.76} ${cx-rx*.6} ${cy+ry} ${cx} ${cy+ry} C${cx+rx*.68} ${cy+ry} ${cx+rx*1.04} ${cy+ry*.66} ${cx+rx*.9} ${cy-ry*.3}`
  mountInk(el,[path],w,h,'circle')
}
