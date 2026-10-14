// Reuse topic anchors: updates must not remount the whole table of contents.
const motions = new WeakMap()
export function updateRail(rail, spaces) {
  const focus = rail.contains(document.activeElement) ? document.activeElement : null
  const scroll = rail.scrollTop
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const existing = new Map([...rail.querySelectorAll('a[data-jump]')].map(a => [a.dataset.jump, a]))
  const before = new Map([...existing.values()].map(a => [a, a.getBoundingClientRect()]))
  for (const a of existing.values()) { motions.get(a)?.cancel(); motions.delete(a) }
  const areas = new Map()
  for (const space of spaces) { const key = space.area || ''; if (!areas.has(key)) areas.set(key, []); areas.get(key).push(space) }
  const grouped = [...areas.keys()].filter(Boolean).length > 1
  const groups = new Map([...rail.querySelectorAll('.rail-area')].map(el => [el.dataset.area || '', el]))
  const keep = new Set(), added = []
  function anchor(space) {
    const a = existing.get(space.id) || document.createElement('a')
    if (!existing.has(space.id)) added.push(a)
    a.href = '#'; a.dataset.jump = space.id; a.title = space.name
    if (a.textContent !== space.name) a.textContent = space.name
    return a
  }
  function place(parent, nodes) { nodes.forEach((node,i) => { if(parent.children[i]!==node)parent.insertBefore(node,parent.children[i] || null) }) }
  if (grouped) {
    const ordered = [...areas.entries()].sort(([a],[b]) => !a ? 1 : !b ? -1 : 0)
    const sections = ordered.map(([name, list]) => {
      const group = groups.get(name) || document.createElement('div')
      group.className = 'rail-area'; group.dataset.area = name
      let label = group.querySelector('.rail-label')
      if (name && !label) { label = document.createElement('span'); label.className = 'rail-label' }
      if (label) label.textContent = name.toLowerCase()
      const nodes = [...(label ? [label] : []), ...list.map(anchor)]
      nodes.forEach(n=>keep.add(n));place(group,nodes);keep.add(group)
      return group
    })
    place(rail,sections)
  } else { const nodes=spaces.map(anchor);nodes.forEach(n=>keep.add(n));place(rail,nodes) }
  for (const el of [...rail.querySelectorAll('a, .rail-label, .rail-area')].reverse()) if(!keep.has(el))el.remove()
  if (focus?.isConnected && document.activeElement !== focus) focus.focus({preventScroll:true})
  rail.scrollTop = scroll
  if(reduce || document.hidden)return
  for(const [a,r] of before){if(!a.isConnected)continue;const to=a.getBoundingClientRect(),dy=r.top-to.top,dx=r.left-to.left;if(Math.abs(dx)+Math.abs(dy)<1)continue;const anim=a.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'none'}],{duration:300,easing:'cubic-bezier(.4,0,.2,1)'});motions.set(a,anim)}
  if(before.size)for(const a of added)a.animate([{opacity:0,clipPath:'inset(0 100% 0 0)'},{opacity:1,clipPath:'inset(0 0% 0 0)'}],{duration:360,delay:100,easing:'cubic-bezier(.4,0,.2,1)',fill:'backwards'})
}
