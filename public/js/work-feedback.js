// A projection of durable inbox/outbox facts, shared by the stage and queue.
// A running batch does not identify which individual note the agent is using.
export function pendingView(snapshot, local = [], flying = 0, retaining = []) {
  const settle = snapshot.settle || {}
  const received = new Set((snapshot.captures || []).map(c => c.requestId).filter(Boolean))
  const queue = (snapshot.captures || []).map(c => ({id:`server:${c.id}`, text:c.text, hint:c.hint,
    status:!settle.running && settle.lastError ? 'Waiting for retry' : settle.captureOnly ? 'Saved in December' : 'Received by December'}))
  for (const job of local) {
    if (received.has(job.id)) continue
    queue.push({id:`local:${job.id}`,text:job.text,hint:job.hint,
      status:job.error ? 'Not sent yet · saved here' : 'Saved here · waiting to send',error:!!job.error})
  }
  for (const job of retaining) {
    if (!queue.some(row => row.text === job.text)) queue.push({id:`retaining:${job.id}`,text:job.text,hint:job.hint,status:'Keeping your note'})
  }
  const retryLocal = queue.some(row=>row.error)
  const retryAgent = !settle.running && !!settle.lastError && queue.some(row=>row.id.startsWith('server:'))
  const mode = settle.running ? 'working' : retryAgent ? 'failed' : retryLocal ? 'send-failed' : local.length ? 'sending' : retaining.length ? 'retaining' : settle.captureOnly ? 'saved' : flying ? 'filing' : 'waiting'
  return {queue,show:queue.length > 0 || !!settle.running || flying > 0,mode,retryLocal,retryAgent}
}

// A run is one agent pass over the inbox. Its destinations are facts only:
// an activity row for a capture that has left the inbox, or a card the running
// pass changed whose block/item src is one of the run's captures. `changed`
// answers 'new', 'edit' or false for what the page has not shown yet.
export function runDestinations(snapshot, seen, changed) {
  const inbox = new Set((snapshot.captures || []).map(c => c.id))
  const out = new Set()
  for (const a of snapshot.activity || []) {
    if (!seen.has(a.captureId) || inbox.has(a.captureId)) continue
    const space = (snapshot.spaces || []).find(s => s.name === a.space)
    if (space) out.add(space.id)
  }
  if (!snapshot.settle?.running || !inbox.size) return out
  for (const space of snapshot.spaces || []) {
    const kind = !space.finished && changed(space)
    if (!kind) continue
    const sourced = (space.blocks || []).some(b => seen.has(b.src) ||
      [...(b.items || []), ...(b.entries || [])].some(row => seen.has(row.src)))
    // the agent makes a space before it files the capture that asked for it
    if (sourced || kind === 'new') out.add(space.id)
  }
  return out
}

// Wait for the agent to stop: an empty inbox can precede its final card edit.
// A terminal error also releases partial results. Never a timer.
export const passComplete = (snapshot, ran) => !snapshot.settle?.running && (ran || !(snapshot.captures || []).length)

// One acknowledgement per destination, at most three flights, within 320ms.
// All other saved cards become readable immediately, including reduced motion.
export function filingPlan(targets, visible) {
  let count = 0
  return [...new Set(targets)].map(target => ({target,
    delay:visible(target) && count < 3 ? count++ * 160 : null}))
}
