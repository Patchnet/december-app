// Shared structured action -> existing durable tool surface. Model output
// never selects a tool or supplies arbitrary arguments here.
export function captureAction(decision, lists, source) {
  if(typeof source!=='string'||!source)throw new Error('Capture source required')
  if(decision.action==='append'){
    const target=lists.find(l=>l.id===decision.target)
    const items=decision.items||[decision.item]
    if(!target||!items.length||items.length>12||items.some(i=>typeof i!=='string'||!i.trim()||i.length>160))throw new Error('Invalid append action')
    return {version:1,type:'append',source,operationId:'jev-append-v1',tool:'december_add_or_check',
      arguments:{blockId:target.id,add:items},spaceId:target.spaceId,
      summary:items.length===1?`Added ${items[0]}`:`Added ${items.length} items`}
  }
  if(decision.action==='create'){
    if(typeof decision.name!=='string'||!decision.name.trim()||!Array.isArray(decision.items)||decision.items.length<2||decision.items.length>8||decision.items.some(i=>typeof i!=='string'||!i.trim()))throw new Error('Invalid checklist action')
    return {version:1,type:'create',source,operationId:'jev-create-v1',tool:'december_create_block',
      arguments:{space:decision.name,type:'list',title:decision.name,items:decision.items},summary:`Created ${decision.name} checklist`}
  }
  throw new Error('Unsupported capture action')
}
export async function commitCaptureAction(action,callTool){
  const result=await callTool(action.tool,{...action.arguments,source:action.source,operationId:action.operationId})
  const space=action.spaceId||result?.spaceId
  if(!space)throw new Error('Saved action has no destination; capture left for recovery')
  await callTool('december_file_capture',{captureId:action.source,space,summary:action.summary,source:action.source,operationId:'jev-file-v1'})
  return {space,operationId:action.operationId}
}
