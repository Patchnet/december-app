// One engine job at a time. Foreground jobs preempt disposable background
// inference; background jobs remain queued and retry against fresh inputs.
export function createAgentScheduler({onChange=()=>{},onTiming=()=>{}}={}) {
  const queue=[]
  let active=null, closed=false
  function pump() {
    if(active || closed || !queue.length)return
    queue.sort((a,b)=>Number(a.background)-Number(b.background))
    const job=queue.shift()
    active=job
    onTiming(job.key.split(':')[0],performance.now()-job.queuedAt)
    job.controller=new AbortController()
    onChange()
    Promise.resolve().then(()=>{if(job.controller.signal.aborted)throw new Error('job cancelled');return job.run(job.controller.signal)}).then(value=>{
      if(job.preempted && !closed){job.queuedAt=performance.now();queue.push(job)}
      else job.resolve(value)
    },error=>{
      if(job.preempted && !closed){job.queuedAt=performance.now();queue.push(job)}
      else job.reject(error)
    }).finally(()=>{active=null;onChange();pump()})
  }
  function enqueue(key,run,{background=false,signal}={}) {
    if(closed || signal?.aborted)return Promise.reject(new Error('job cancelled'))
    const existing=[active,...queue].find(job=>job?.key===key)
    if(existing)return existing.promise
    if(queue.length>=16)return Promise.reject(new Error('Agent queue is full; try again shortly'))
    let resolve,reject
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no})
    const job={key,run,background,resolve,reject,promise,preempted:false,queuedAt:performance.now()}
    const abort=()=>{
      if(active===job){job.preempted=false;job.controller.abort()}
      else {const i=queue.indexOf(job);if(i>=0){queue.splice(i,1);reject(new Error('job cancelled'))}}
    }
    signal?.addEventListener('abort',abort,{once:true})
    promise.then(()=>signal?.removeEventListener('abort',abort),()=>signal?.removeEventListener('abort',abort))
    // Reset the preemption flag on each attempt, not when it is queued.
    const action=job.run
    job.run=s=>{job.preempted=false;return action(s)}
    queue.push(job)
    if(!background && active?.background){active.preempted=true;active.controller.abort()}
    onChange();pump()
    return promise
  }
  return {enqueue,status:()=>({active:active?.key||null,queued:queue.map(j=>j.key)}),close(){
    closed=true
    if(active){active.preempted=false;active.controller.abort()}
    for(const job of queue.splice(0))job.reject(new Error('scheduler stopped'))
  }}
}

// A first-arrival deadline prevents a stream of typing from starving work.
export function createCaptureDebounce(run,{delay=150,maxWait=500,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}) {
  let timer=null,first=null
  return {
    schedule(wait=delay){
      const at=now();first ??= at
      clearTimer(timer)
      timer=setTimer(()=>{timer=null;first=null;run()},Math.max(0,Math.min(wait,maxWait-(at-first))))
    },
    cancel(){clearTimer(timer);timer=null;first=null},
  }
}
