// Session-only aggregate diagnostics. Never retain captures, responses or keys.
const samples=[]
export function recordJev(result) {
  samples.push({outcome:result.outcome,reason:result.reason,
    requestMs:result.requestMs,saveMs:result.saveMs,durationMs:result.durationMs})
  if(samples.length>100)samples.shift()
}
export function jevMetrics() {
  const timing=key=>{
    const values=samples.map(s=>s[key]).filter(Number.isFinite).sort((a,b)=>a-b)
    const percentile=p=>values.length?values[Math.max(0,Math.ceil(values.length*p)-1)]:null
    return {count:values.length,p50:percentile(.5),p95:percentile(.95)}
  }
  const reasons={}
  for(const s of samples)if(s.outcome==='fallback')reasons[s.reason]=(reasons[s.reason]||0)+1
  return {samples:samples.length,fallbacks:reasons,requestMs:timing('requestMs'),saveMs:timing('saveMs'),durationMs:timing('durationMs')}
}
