// One read at a time. Invalidations during a read request one trailing read,
// so a final save is never lost and bursts cannot pile up stale requests.
export function coalescedRefresh(read) {
  let running=null,again=false
  return function refresh() {
    if(running){again=true;return running}
    running=(async()=>{
      do{again=false;await read()}while(again)
    })().finally(()=>{running=null})
    return running
  }
}
