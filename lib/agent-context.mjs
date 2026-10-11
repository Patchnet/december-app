import {createHash} from 'node:crypto'

export const contentVersion=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24)

// Whole records only. Coverage is explicit; no sliced serialized JSON.
export function boundedRecords(records,{maxBytes=48000,offset=0,limit=100}={}) {
  if(!Number.isSafeInteger(offset)||offset<0)throw new Error('offset must be a nonnegative integer')
  const items=[]
  let bytes=2,index=Math.max(0,Number(offset)||0)
  for(;index<records.length && items.length<limit;index++) {
    const size=Buffer.byteLength(JSON.stringify(records[index]))+1
    if(bytes+size>maxBytes)break
    items.push(records[index]);bytes+=size
  }
  return {items,total:records.length,offset:Math.max(0,Number(offset)||0),nextOffset:index<records.length?index:null,complete:index>=records.length,bytes}
}

export function compactAgentView(view,{offset=0,limit=100,maxBytes=48000}={}) {
  const captures=view.captures||[]
  const text=captures.map(c=>c.text).join(' ' ).toLocaleLowerCase()
  const ranked=[...view.spaces].map((space,index)=>({space,index,score:captures.some(c=>c.hint===space.id || c.hint===space.name)?1000:text.includes(String(space.name).toLocaleLowerCase())?100:0})).sort((a,b)=>b.score-a.score||a.index-b.index)
  const catalog=ranked.map(({space})=>({
    id:space.id,name:space.name,area:space.area,pinned:space.pinned,version:space.version,
    blocks:space.blocks.map(block=>({id:block.id,type:block.type,title:block.title,entities:block.entities,version:block.version,
      summary:String(block.text || block.title || '').slice(0,160),
      ...(block.items?{itemCount:block.items.length+(block.moreDone||0)}:{}),
      ...(block.total!==undefined?{total:block.total,unit:block.unit}:{}),
      ...(block.when?{when:block.when,at:block.at,done:block.done}:{}),
      detailRequired:true})),
  }))
  const page=boundedRecords(catalog,{offset,limit,maxBytes})
  // Oversized spaces are represented by a small catalog entry. Individual
  // blocks remain discoverable with read_space rather than blocking paging.
  if(page.nextOffset===page.offset && catalog[page.offset]) {
    const space=catalog[page.offset]
    page.items=[{id:space.id,name:space.name,version:space.version,blocks:[],blockCount:space.blocks.length,detailRequired:true}]
    page.nextOffset=page.offset+1<catalog.length?page.offset+1:null
    page.complete=page.nextOffset===null
  }
  return {...view,spaces:page.items,coverage:{totalSpaces:page.total,nextOffset:page.nextOffset,complete:page.complete},
    instructions:'Read candidate blocks with december_read_block before editing. Use december_read_space for omitted block catalogs. Continue december_view with nextOffset to inspect more spaces. Never infer absent content from this catalog.'}
}
