// Reconcile a card's rendered content without remounting its media, disclosures
// or input. Stable block/item IDs let task rows move between open and done.
function key(node) {
  if(node.nodeType!==1)return null
  if(node.dataset.bid)return `block:${node.dataset.bid}`
  if(node.dataset.block)return `row:${node.dataset.block}/${node.dataset.item || ''}`
  if(node.matches('details'))return `fold:${node.closest('[data-bid]')?.dataset.bid || ''}:${node.className}`
  return null
}
export function updateCardContent(card,html) {
  const template=document.createElement('template')
  template.innerHTML=html
  const keyed=new Map([...card.querySelectorAll('*')].map(node=>[key(node),node]).filter(([id])=>id))
  const field=card.querySelector('.focus-capture')
  const focused=document.activeElement
  const scroll=card.scrollTop
  const used=new Set()
  function compatible(a,b) {
    return a.nodeType===b.nodeType && (a.nodeType!==1 || (a.tagName===b.tagName && a.classList[0]===b.classList[0] && !key(a)))
  }
  function children(parent,source) {
    let cursor=parent.firstChild
    const keep=new Set()
    for(const desired of [...source.childNodes]) {
      const id=key(desired)
      let node=id ? keyed.get(id) : null
      if(node && (used.has(node) || node.tagName!==desired.tagName))node=null
      if(!node && !id)node=[...parent.childNodes].find(candidate=>!used.has(candidate) && candidate!==field && compatible(candidate,desired))
      if(!node)node=desired.cloneNode(false)
      used.add(node);keep.add(node)
      if(node!==cursor)parent.insertBefore(node,cursor)
      cursor=node.nextSibling
      if(node.nodeType===1) {
        const open=node.tagName==='DETAILS' && node.open
        for(const attr of [...node.attributes])if(!desired.hasAttribute(attr.name) && attr.name!=='aria-busy')node.removeAttribute(attr.name)
        for(const attr of desired.attributes)if(node.getAttribute(attr.name)!==attr.value)node.setAttribute(attr.name,attr.value)
        if(open)node.open=true
        children(node,desired)
      } else if(node.nodeValue!==desired.nodeValue)node.nodeValue=desired.nodeValue
    }
    for(const node of [...parent.childNodes])if(!keep.has(node) && node!==field)node.remove()
  }
  children(card,template.content)
  // A moved focused checkbox can lose focus during DOM insertion.
  if(focused?.isConnected && document.activeElement!==focused)focused.focus?.({preventScroll:true})
  card.scrollTop=scroll
}
