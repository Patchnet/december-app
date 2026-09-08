import {api,page,hooks,adoptState,toast} from './session.js'
const pending=new Set()

// A question may be replaced during the request. Keep a failed typed answer
// available with its original question instead of putting it into the new ask.
function recoverAnswer(question,answer) {
  const dialog=document.createElement('dialog')
  dialog.className='pending-dialog'
  dialog.setAttribute('aria-label','Unconfirmed answer')
  dialog.innerHTML='<div class="surface-heading"><h2>Keep your answer</h2><button type="button" class="surface-close">Close</button></div><p class="pending-summary">This answer was not confirmed. You can copy it before closing.</p><p class="pending-note"></p><textarea class="capture" aria-label="Your original answer" readonly></textarea>'
  dialog.querySelector('.pending-note').textContent=question
  const field=dialog.querySelector('textarea');field.value=answer
  dialog.querySelector('button').onclick=()=>dialog.close()
  dialog.addEventListener('close',()=>{dialog.remove();(document.querySelector('.ask-input') || page.field).focus({preventScroll:true})},{once:true})
  document.body.append(dialog);dialog.showModal()
  field.style.height=`${Math.min(220,field.scrollHeight)}px`
  field.focus();field.select()
}
export async function submitAnswer(control,choice,typed=false) {
  const panel=control.closest('[data-ask-id]')
  const askId=panel?.dataset.askId
  if(!askId || pending.has(askId))return
  const question=panel.querySelector('.ask-q')?.textContent || ''
  const controls=[...panel.querySelectorAll('button,input')]
  pending.add(askId)
  controls.forEach(item=>{item.disabled=true})
  panel.setAttribute('aria-busy','true')
  try {
    adoptState(await api('/api/answer',{askId,choice,typed},{signal:AbortSignal.timeout(15000)}))
    hooks.render();hooks.schedulePoll()
  } catch(error) {
    try{adoptState(await api('/api/state',undefined,{signal:AbortSignal.timeout(5000)}))}catch{}
    hooks.render()
    if(typed && choice && (page.state.ask?.id !== askId || !panel.isConnected))recoverAnswer(question,choice)
    toast(error.message)
  } finally {
    pending.delete(askId)
    controls.forEach(item=>{item.disabled=false;item.classList.remove('picked')})
    panel.removeAttribute('aria-busy')
  }
}
