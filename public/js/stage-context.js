import { esc } from './session.js'
import { openStageCard } from './layout.js'

/** Reuse the server's recent receipt window; never infer a filing destination. */
export function stageReceipts(snapshot) {
  const spaces = snapshot.spaces || []
  return (snapshot.activity || []).map((entry,index) => {
    const matches = spaces.filter(space => space.name === entry.space && !space.finished)
    return {...entry,key:`${entry.at || ''}/${index}`,sid:matches.length === 1 ? matches[0].id : null}
  })
}

/** When a change happened, the way you would say it: a time today, a day
    otherwise. Empty when the record carries no time. */
export function stamp(value) {
  const date=new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const today=new Date().toDateString() === date.toDateString()
  return date.toLocaleString(undefined,today ? {hour:'numeric',minute:'2-digit'} : {month:'short',day:'numeric'}).toLowerCase()
}

/** A receipt in the sheet: the card it touched, what changed, and when. */
function receiptHTML(entry) {
  const tag=entry.sid?'button':'div'
  return `<${tag} class="today-row plain trace full"${entry.sid?` type="button" data-receipt="${esc(entry.key)}" aria-label="Open ${esc(entry.space || 'December')}: ${esc(entry.summary || 'Updated')}"`:''}>
    <span class="tick-slot"></span><span class="row-text"><span class="trace-space">${esc(entry.space || 'December')}</span>${esc(entry.summary || 'Updated')}</span>
    <span class="today-sub"><time>${esc(stamp(entry.at))}</time></span>
  </${tag}>`
}

/** The record of what the page has done lately, as a sheet. It is a
    record of what moved in the person's own cards — never the page
    talking about itself. Opened from the stage's shape line. */
export function openHistory(receipts,onOpen=openStageCard) {
  if (!receipts.length) return
  const dialog=document.createElement('dialog')
  dialog.className='stage-history'
  dialog.setAttribute('aria-labelledby','stage-history-title')
  dialog.innerHTML=`<div class="surface-heading"><h2 id="stage-history-title">Recent changes</h2><button class="surface-close" type="button">Close</button></div><p class="stage-history-intro">The latest ${receipts.length} changes recorded by December. Open a card to pick up from there.</p><div class="stage-history-list">${receipts.map(entry=>receiptHTML(entry)).join('')}</div>`
  const entries=[...receipts]
  const returnTo=document.activeElement
  dialog.querySelector('.surface-close').onclick=()=>dialog.close()
  dialog.addEventListener('click',event=>{
    if(event.target===dialog){dialog.close();return}
    const button=event.target.closest('[data-receipt]')
    const entry=entries.find(item=>item.key===button?.dataset.receipt)
    if(entry?.sid){dialog.close();onOpen(entry.sid)}
  })
  dialog.addEventListener('close',()=>{dialog.remove();returnTo?.focus?.({preventScroll:true})},{once:true})
  document.body.appendChild(dialog)
  dialog.showModal()
}
