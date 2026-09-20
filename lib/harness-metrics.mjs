// Bounded, process-local durations only. No arguments, output or error text.
export function createHarnessMetrics({now=()=>performance.now(),limit=100}={}) {
  const samples=new Map()
  function start(name) {
    const at=now();let ended=false
    return (failed=false)=>{
      if(ended)return;ended=true
      const rows=samples.get(name)||[]
      rows.push({ms:Math.max(0,Math.round(now()-at)),failed:!!failed})
      if(rows.length>limit)rows.shift()
      samples.set(name,rows)
    }
  }
  async function measure(name,action){
    const end=start(name)
    try{const value=await action();end();return value}catch(error){end(true);throw error}
  }
  function snapshot(){
    return Object.fromEntries([...samples].map(([name,rows])=>{
      const durations=rows.map(r=>r.ms).sort((a,b)=>a-b)
      return [name,{count:rows.length,failures:rows.filter(r=>r.failed).length,
        latestMs:rows.at(-1).ms,p50Ms:durations[Math.ceil(rows.length*.5)-1],p95Ms:durations[Math.ceil(rows.length*.95)-1]}]
    }))
  }
  return {start,measure,snapshot}
}
export const harnessMetrics=createHarnessMetrics()
