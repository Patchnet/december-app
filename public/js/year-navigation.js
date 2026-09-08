// One navigation intent owns an asynchronous year/month response.
let revision = 0
export const beginYearRequest = () => ++revision
export const invalidateYearRequest = () => { revision++ }
export const currentYearRequest = ticket => ticket === revision

export function yearPosition(year, now = new Date()) {
  const start = new Date(year,0,1), end = new Date(year+1,0,1), december = new Date(year,11,1)
  const through = Math.max(0,Math.min(1,(now-start)/(end-start)))
  return {through,daysToDecember:Math.max(0,Math.ceil((december-now)/86400000)),daysLeft:Math.max(0,Math.ceil((end-now)/86400000))}
}

export function showYearSurface(wrap, html, direction = 1) {
  const previous = wrap.querySelector('.year-card, .month-card')
  const oldHeight = previous?.getBoundingClientRect().height
  const frame = wrap.querySelector('.focus-wrap')
  if (previous && frame) {
    const template = document.createElement('template')
    template.innerHTML = html
    frame.replaceChildren(template.content.querySelector('.focus-card'))
  } else wrap.innerHTML = html
  const card = wrap.querySelector('.focus-card')
  if (card && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && card.animate) {
    const height = card.getBoundingClientRect().height
    card.animate([
      {height:`${oldHeight || height}px`,opacity:previous ? .65 : 0,transform:`translate${previous ? 'X' : 'Y'}(${previous ? direction*16 : 10}px) scale(.99)`},
      {height:`${height}px`,opacity:1,transform:'none'},
    ],{duration:380,easing:'cubic-bezier(.22,1,.36,1)'})
  }
}
