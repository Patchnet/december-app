import {api,page,hooks,adoptState,toast} from './session.js'
import {parseCaptureInput} from './capture-input.js'
import {createCaptureOutbox,indexedCaptureStore} from './capture-outbox.js'
let outbox
function queue() {
  if (!outbox) outbox=createCaptureOutbox({
    store:indexedCaptureStore(indexedDB),
    send:job=>api('/api/capture',{text:job.text,hint:job.hint,requestId:job.id},{signal:AbortSignal.timeout(15000)}),
    onChange:jobs=>{
      page.queuedCaptures=jobs
      page.queuedTexts=jobs.map(job=>job.text)
      page.captureError=jobs.find(job=>job.error)?.error || null
      if(page.state)hooks.render()
    },
    onState:response=>{adoptState(response);hooks.schedulePoll()},
  })
  return outbox
}
export async function retainSubmission(text,hint) {
  parseCaptureInput(text) // all-or-nothing validation before the field clears
  return queue().enqueue(text,hint)
}
export function deliverCaptures() {
  return queue().flush().catch(error=>toast(`Your note is still saved here. ${error.message}`))
}
hooks.startCaptureOutbox=()=>queue().load().then(()=>{void deliverCaptures()}).catch(error=>toast(`Could not open saved notes: ${error.message}`))
hooks.retryCaptureOutbox=deliverCaptures
window.addEventListener('online',()=>{if(page.state)deliverCaptures()})
