// Drain only the inbox observed at pass start, in order. The first fallback
// hands the remaining work to the organizer; never skip ahead or loop forever.
export async function runJevPass({attempt, pendingIds, onResult=()=>{}, limit=8}) {
  const initial=new Set(pendingIds())
  const results=[]
  for(let i=0;i<Math.min(limit,initial.size);i++){
    const before=pendingIds()
    if(!before.length || !initial.has(before[0]))break
    const result=await attempt()
    results.push(result);onResult(result)
    if(!['appended','created'].includes(result.outcome))break
    const after=pendingIds()
    // A success must actually remove its capture. Protect against an adapter
    // claiming success without progress, or acting out of inbox order.
    if(!result.captureId || result.captureId!==before[0] || after.includes(result.captureId))break
  }
  return results
}
