const normalized=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().trim()

export function createSearchIndex(spaces) {
  const rows=[]
  const add=(id,label,space,sid,active=true)=>{if(label)rows.push({id,label,space,sid,active,key:normalized(label)})}
  for(const s of spaces) {
    add(s.id,s.name,'',s.id,!s.finished)
    for(const b of s.blocks) {
      if(b.title)add(`${b.id}:title`,b.title,s.name,s.id,!s.finished)
      if(b.type==='list')for(const i of b.items)add(i.id,i.text,s.name,s.id,!s.finished&&!i.done)
      if(b.type==='reminder')add(b.id,b.text,s.name,s.id,!s.finished&&!b.done)
      if(b.type==='note')add(b.id,b.text,s.name,s.id,!s.finished)
      if(b.type==='ledger')for(const e of b.entries)add(e.id,e.label,s.name,s.id,!s.finished)
    }
  }
  return rows
}

export function searchIndex(index,query,{limit=8,spaceId}={}) {
  const q=normalized(query)
  if(!q)return []
  return index.filter(r=>r.key.includes(q)).map(r=>({...r,score:
    (r.key===q?400:r.key.startsWith(q)?300:r.key.split(/\s+/).includes(q)?200:100)+
    (r.sid===spaceId?20:0)+(r.active?10:0),
  })).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit).map(r=>{
    if(r.label.length<160)return r
    const at=r.key.indexOf(q)
    return {...r,label:`…${r.label.slice(Math.max(0,at-12),at+60)}…`}
  })
}
