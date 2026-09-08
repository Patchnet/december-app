// A projection of durable inbox/outbox facts, shared by the stage and queue.
// A running batch does not identify which individual note the agent is using.
export function pendingView(snapshot, local = [], flying = 0) {
  const settle = snapshot.settle || {}
  const received = new Set((snapshot.captures || []).map(c => c.requestId).filter(Boolean))
  const queue = (snapshot.captures || []).map(c => ({id:`server:${c.id}`, text:c.text, hint:c.hint,
    status:!settle.running && settle.lastError ? 'Waiting for retry' : settle.captureOnly ? 'Saved in December' : 'Received by December'}))
  for (const job of local) {
    if (received.has(job.id)) continue
    queue.push({id:`local:${job.id}`,text:job.text,hint:job.hint,
      status:job.error ? 'Not sent yet · saved here' : 'Saved here · waiting to send',error:!!job.error})
  }
  const retryLocal = queue.some(row=>row.error)
  const retryAgent = !settle.running && !!settle.lastError && queue.some(row=>row.id.startsWith('server:'))
  const mode = settle.running ? 'working' : retryAgent ? 'failed' : retryLocal ? 'send-failed' : local.length ? 'sending' : settle.captureOnly ? 'saved' : flying ? 'filing' : 'waiting'
  return {queue,show:queue.length > 0 || !!settle.running || flying > 0,mode,retryLocal,retryAgent}
}

// One acknowledgement per destination, at most three flights, within 320ms.
// All other saved cards become readable immediately, including reduced motion.
export function filingPlan(targets, visible) {
  let count = 0
  return [...new Set(targets)].map(target => ({target,
    delay:visible(target) && count < 3 ? count++ * 160 : null}))
}
