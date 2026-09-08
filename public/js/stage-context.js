import { esc } from './session.js'
const contexts = new WeakMap()

/** Reuse the server's recent receipt window; never infer a filing destination. */
export function stageReceipts(snapshot) {
  const spaces = snapshot.spaces || []
  return (snapshot.activity || []).map((entry,index) => {
    const matches = spaces.filter(space => space.name === entry.space && !space.finished)
    return {...entry,key:`${entry.at || ''}/${index}`,sid:matches.length === 1 ? matches[0].id : null}
  })
}

function stamp(value) {
  const date=new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const today=new Date().toDateString() === date.toDateString()
  return date.toLocaleString(undefined,today ? {hour:'numeric',minute:'2-digit'} : {month:'short',day:'numeric'})
}

function receiptHTML(entry,full=false) {
  const tag=entry.sid?'button':'div'
  return `<${tag} class="stage-receipt${full?' full':''}"${entry.sid?` type="button" data-receipt="${esc(entry.key)}"`:''}>
    <span class="stage-receipt-copy"><span class="stage-receipt-title">${esc(entry.space || 'December')}</span><span class="stage-receipt-summary">${esc(entry.summary || 'Updated')}</span></span>
    <span class="stage-receipt-tail"><time>${esc(stamp(entry.at))}</time>${entry.sid?'<span aria-hidden="true">↗</span>':''}</span>
  </${tag}>`
}

function history(ctx) {
  const dialog=document.createElement('dialog')
  dialog.className='stage-history'
  dialog.setAttribute('aria-labelledby','stage-history-title')
  dialog.innerHTML=`<div class="surface-heading"><h2 id="stage-history-title">Recent changes</h2><button class="surface-close" type="button">Close</button></div><p class="stage-history-intro">The latest ${ctx.receipts.length} changes recorded by December. Open a card to pick up from there.</p><div>${ctx.receipts.map(entry=>receiptHTML(entry,true)).join('')}</div>`
  const entries=[...ctx.receipts]
  dialog.querySelector('.surface-close').onclick=()=>dialog.close()
  dialog.addEventListener('click',event=>{
    if(event.target===dialog){dialog.close();return}
    const button=event.target.closest('[data-receipt]')
    const entry=entries.find(item=>item.key===button?.dataset.receipt)
    if(entry?.sid){dialog.close();ctx.onOpen(entry.sid)}
  })
  dialog.addEventListener('close',()=>dialog.remove(),{once:true})
  document.body.appendChild(dialog)
  dialog.showModal()
}

export function renderStageContext({root,state,count=0,onToday,onHelp,onOpen}) {
  if (!root) return
  let ctx=contexts.get(root)
  if (!ctx) {
    root.innerHTML='<div class="stage-context-nav"><div class="stage-tabs" role="tablist" aria-label="Stage context"><button type="button" role="tab" id="stage-tab-today" aria-controls="today" data-stage-view="today">Today<span></span></button><button type="button" role="tab" id="stage-tab-recent" aria-controls="stage-recent" data-stage-view="recent">Recent<span></span></button></div><button type="button" class="stage-help">What can I say?</button></div><div id="stage-recent" role="tabpanel" aria-labelledby="stage-tab-recent" hidden></div>'
    ctx={view:null,needsFit:true,receipts:[],root,today:document.querySelector('#today'),recent:root.querySelector('#stage-recent')}
    // The Today content follows the controls; Recent occupies that same slot.
    root.appendChild(ctx.today)
    ctx.today.setAttribute('role','tabpanel')
    ctx.today.setAttribute('aria-labelledby','stage-tab-today')
    contexts.set(root,ctx)
    root.addEventListener('click',event=>{
      const tab=event.target.closest('[data-stage-view]')
      if(tab){ctx.view=tab.dataset.stageView;paint(ctx,true);return}
      if(event.target.closest('.stage-help')){ctx.onHelp();return}
      if(event.target.closest('.stage-history-open')){history(ctx);return}
      const button=event.target.closest('[data-receipt]')
      const entry=ctx.receipts.find(item=>item.key===button?.dataset.receipt)
      if(entry?.sid)ctx.onOpen(entry.sid)
    })
    root.addEventListener('keydown',event=>{
      if(!event.target.matches('[role="tab"]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
      event.preventDefault()
      ctx.view=event.key==='Home'?'today':event.key==='End'?'recent':ctx.view==='today'?'recent':'today'
      paint(ctx,true)
      root.querySelector(`[data-stage-view="${ctx.view}"]`).focus()
    })
  }
  Object.assign(ctx,{onToday,onHelp,onOpen,count,receipts:stageReceipts(state)})
  if(!ctx.view)ctx.view=count?'today':ctx.receipts.length?'recent':'today'
  paint(ctx)
}

function paint(ctx,animate=false) {
  const {root,today,recent,view,receipts,count}=ctx
  const wasToday=!today.hidden
  for(const tab of root.querySelectorAll('[role="tab"]')){
    const selected=tab.dataset.stageView===view
    tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1
    tab.querySelector('span').textContent=tab.dataset.stageView==='today'?(count?` ${count}`:''):(receipts.length?` ${receipts.length}`:'')
  }
  today.hidden=view!=='today'||!count
  recent.hidden=view!=='recent'||!receipts.length
  const key=JSON.stringify(receipts)
  if(ctx.key!==key){
    recent.innerHTML=receipts.length?receiptHTML(receipts[0])+`<button type="button" class="stage-history-open" aria-haspopup="dialog">View recent changes${receipts.length>1?` · ${receipts.length}`:''}</button>`:''
    ctx.key=key
  }
  if(!today.hidden&&(!wasToday||ctx.needsFit)){delete today.dataset.key;ctx.onToday();ctx.needsFit=false}
  const panel=view==='today'?today:recent
  if(animate&&!panel.hidden&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    panel.getAnimations().forEach(animation=>animation.cancel())
    panel.animate([{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'none'}],{duration:220,easing:'cubic-bezier(.16,1,.3,1)'})
  }
}
