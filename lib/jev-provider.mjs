// No automatic retries: after repeated transport failures the organizer gets
// work immediately. A single probe is allowed after the cooldown expires.
export function createJevProvider(request,{now=()=>Date.now(),threshold=3,cooldownMs=15000}={}) {
  let failures=0,until=0,probing=false
  return async (...args)=>{
    const probe=failures>=threshold
    if(probe && (now()<until || probing))throw new Error('Jev temporarily unavailable')
    if(probe)probing=true
    try{
      const result=await request(...args)
      failures=0;until=0
      return result
    }catch(error){
      failures++
      if(failures>=threshold)until=now()+cooldownMs
      throw error
    }finally{if(probe)probing=false}
  }
}
