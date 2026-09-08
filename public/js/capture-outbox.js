// Browser-retained capture requests. IDs survive retries and reloads; only a
// matching server receipt removes an entry. This owns no agent behavior.
export function indexedCaptureStore(indexedDB) {
  const opened = new Promise((resolve,reject) => {
    const request = indexedDB.open('december-capture-outbox',1)
    request.onupgradeneeded = () => request.result.createObjectStore('captures',{keyPath:'id'})
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Close another December window to open saved notes.'))
  })
  const transact = async (mode,operation) => {
    const db = await opened
    return new Promise((resolve,reject) => {
      const tx=db.transaction('captures',mode),request=operation(tx.objectStore('captures'))
      tx.oncomplete=()=>resolve(request.result)
      tx.onerror=()=>reject(tx.error || request.error)
      tx.onabort=()=>reject(tx.error || new Error('Could not retain the note on this computer.'))
    })
  }
  return {
    list:()=>transact('readonly',store=>store.getAll()),
    put:item=>transact('readwrite',store=>store.put(item)),
    remove:id=>transact('readwrite',store=>store.delete(id)),
  }
}

export function createCaptureOutbox({store,send,onChange=()=>{},onState=()=>{},makeId=()=>crypto.randomUUID()}) {
  let jobs=[],running=null
  const publish = async () => {
    jobs=(await store.list()).sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id))
    onChange(jobs)
  }
  async function enqueue(text,hint) {
    const job={id:makeId(),text,hint,at:Date.now(),error:null}
    await store.put(job) // callers must not clear their field before this succeeds
    await publish()
    return job
  }
  async function drain() {
    await publish()
    // A failed note is retained without blocking independent later notes.
    const attempted=new Set()
    while (true) {
      const job=jobs.find(item=>!attempted.has(item.id))
      if (!job) return
      attempted.add(job.id)
      try {
        const response=await send(job)
        if(response?.captureReceipt?.requestId!==job.id) throw new Error('December did not acknowledge this saved note. Restart the app and retry.')
        onState(response)
        await store.remove(job.id)
      } catch(error) {
        // Keep the original ID and context on uncertain acknowledgement.
        await store.put({...job,error:String(error?.message || error)})
      }
      await publish()
    }
  }
  function flush() {
    if (running) return running
    running=drain().finally(()=>{running=null})
    return running
  }
  return {enqueue,flush,load:publish}
}
