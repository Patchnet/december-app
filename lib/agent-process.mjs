import {spawn as spawnProcess} from 'node:child_process'
import {createInterface as readLines} from 'node:readline'

/** One owner per CLI process; retired children cannot touch a replacement. */
export function createAgentProcess({binary,args,cwd,spawn=spawnProcess,createInterface=readLines}) {
  let owner=null
  const state={proc:null,turns:0,model:null}
  function retire(expected,error=new Error('agent stopped')) {
    if(owner!==expected || !expected)return
    owner=null;state.proc=null
    const waiting=expected.waiting;expected.waiting=null
    expected.reader.close()
    waiting?.reject(error)
    try{expected.proc.kill()}catch{}
  }
  function ensure(model) {
    const executable=typeof binary==='function' ? binary() : binary
    if(owner && (state.model!==model || owner.binary!==executable))retire(owner,new Error('agent configuration changed'))
    if(owner)return
    const proc=spawn(executable,args(model),{cwd})
    const current={proc,binary:executable,reader:createInterface({input:proc.stdout}),waiting:null,stderr:''}
    owner=current;Object.assign(state,{proc,model,turns:0})
    current.reader.on('line',line=>{
      if(owner!==current)return
      let event
      try{event=JSON.parse(line)}catch{return}
      if(event.type!=='result' || !current.waiting)return
      if(event.is_error || (event.subtype && event.subtype!=='success')) {
        retire(current,new Error(`agent turn failed: ${String(event.errors?.join?.('; ') || event.result || event.subtype || 'unknown error').slice(-300)}`))
        return
      }
      const waiting=current.waiting;current.waiting=null
      waiting.resolve(event)
    })
    proc.stderr.on('data',data=>{if(owner===current)current.stderr=(current.stderr+data).slice(-500)})
    // Keep guarded error listeners on retired processes: late 'error' events
    // must be consumed, but may never reject the replacement's waiter.
    proc.on('error',error=>retire(current,new Error(`could not start ${executable}: ${error.code || error.message}`)))
    proc.stdin.on('error',error=>retire(current,new Error(`agent input failed: ${error.message}`)))
    proc.on('exit',()=>retire(current,new Error(`agent exited: ${current.stderr.slice(-200)}`)))
  }
  function turn(text,timeoutMs) {
    const current=owner
    if(!current)return Promise.reject(new Error('agent is not running'))
    if(current.waiting)return Promise.reject(new Error('agent already has an active turn'))
    return new Promise((resolve,reject)=>{
      let timer
      const waiting={resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}}
      current.waiting=waiting
      timer=setTimeout(()=>{
        if(owner===current && current.waiting===waiting)retire(current,new Error('settle turn timed out'))
      },timeoutMs)
      try{
        current.proc.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text}]}})+'\n')
      }catch(error){retire(current,new Error(`agent write failed: ${error.message}`))}
    })
  }
  return {state,ensure,turn,stop:()=>retire(owner)}
}
