import {createHash} from 'node:crypto'

const supported=new Set(['december_create_space','december_create_block','december_add_or_check','december_move_tracker','december_log_amount','december_mark_day','december_write_note','december_set_reminder','december_file_capture','december_write_about','december_learn','december_retitle'])
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export function operationIdentity(tool,args) {
  if(!supported.has(tool))return null
  const source=tool==='december_file_capture' ? args.captureId : args.source
  const operationId=args.operationId
  for(const value of [source,operationId]) if(value!==undefined && (typeof value!=='string' || !value.trim() || value.length>200)) throw new Error('source and operationId must be nonempty strings of at most 200 characters')
  // The public tools accepted identity-free writes before receipts existed.
  // Preserve that contract: these legacy calls remain separate actions.
  // Retry protection is available when the caller supplies source/operationId.
  if(!source && !operationId)return null
  const payload={...args}
  delete payload.operationId
  const signature=hash([tool,payload])
  // Legacy captures use a deterministic action signature. Explicit IDs let two
  // genuinely separate, identical actions coexist in the same capture.
  const id=hash([source || '',operationId || (tool==='december_file_capture' ? 'file' : signature)])
  return {id,signature,source:source || null,operationId:operationId || signature,tool,arguments:canonical(payload)}
}
export const RECEIPT_TOOLS = supported
