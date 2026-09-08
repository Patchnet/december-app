import {isDeepStrictEqual} from 'node:util'

const copy = value => value === undefined ? undefined : structuredClone(value)
const keyed = value => Array.isArray(value) && value.every(item=>item && typeof item.id==='string')
const clean = value => Array.isArray(value) ? value.map(clean) : value && typeof value==='object'
  ? Object.fromEntries(Object.entries(value).filter(([key])=>key!=='updatedAt').map(([key,item])=>[key,clean(item)])) : value
const same = (a,b) => isDeepStrictEqual(clean(a),clean(b))

/** Paths follow stable IDs inside collections, never a row's current position. */
export function undoChanges(before,after,path=[]) {
  if (same(before,after)) return []
  if (keyed(before) && keyed(after)) {
    const old=new Map(before.map(item=>[item.id,item])),next=new Map(after.map(item=>[item.id,item]))
    return [...new Set([...old.keys(),...next.keys()])].flatMap(id=>undoChanges(old.get(id),next.get(id),[...path,{id,index:Math.max(0,before.findIndex(item=>item.id===id))}]))
  }
  if (before && after && !Array.isArray(before) && !Array.isArray(after) && typeof before==='object' && typeof after==='object') {
    return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>key!=='updatedAt')
      .flatMap(key=>undoChanges(before[key],after[key],[...path,key]))
  }
  return [{path,before:copy(before),after:copy(after)}]
}

/** Validate on a private copy first: a conflict never partially reverses work. */
export function reverseChanges(current,operations) {
  const next=structuredClone(current)
  for (const changes of [...operations].reverse()) for (const change of [...changes].reverse()) {
    let parent=next
    for (const part of change.path.slice(0,-1)) {
      parent=typeof part==='object' ? parent?.find?.(item=>item.id===part.id) : parent?.[part]
    }
    const key=change.path.at(-1),isId=typeof key==='object'
    if (!parent) throw new Error('This item changed afterward. Undo would overwrite newer work.')
    const index=isId ? parent.findIndex(item=>item.id===key.id) : key
    const value=isId && index<0 ? undefined : parent[index]
    if (!same(value,change.after)) throw new Error('This item changed afterward. Undo would overwrite newer work.')
    if (isId) {
      if (change.before===undefined) { if(index>=0)parent.splice(index,1) }
      else if(index<0)parent.splice(Math.min(key.index,parent.length),0,copy(change.before))
      else parent[index]=copy(change.before)
    } else if(change.before===undefined) delete parent[index]
    else parent[index]=copy(change.before)
  }
  return next
}
