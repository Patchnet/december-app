import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
let serial=0
async function load(dir) {
  process.env.DECEMBER_DATA_DIR=dir
  return import(`../lib/core.mjs?undo-replay=${++serial}`)
}
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'december-undo-replay-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  return {dir,core:await load(dir)}
}
const block = (core,id) => core.readBlock(id).block
const operation=(core,name,args,action)=>core.executeAgentOperation(name,args,action)

test('manual undo preserves later captures and unrelated edits in the same card',async t=>{
  const {core}=await fixture(t)
  const made=await core.createBlock('Home',{type:'list',items:['Call plumber','Buy tape']})
  const [first,second]=block(core,made.blockId).items
  await core.check(made.blockId,first.id,true)
  const later=await core.addCapture('A thought written after the check')
  await core.updateBlock(made.blockId,{add_items:['Buy paint']},'list')
  await core.updateBlock(made.blockId,{check_item_ids:[second.id]},'list')
  await core.undoManual()
  const items=block(core,made.blockId).items
  assert.equal(items.find(i=>i.id===first.id).done,false)
  assert.equal(items.find(i=>i.id===second.id).done,true)
  assert.equal(items.at(-1).text,'Buy paint')
  assert.ok(core.project().captures.some(c=>c.id===later.id))
})
test('agent undo preserves later intake and manual sibling edits; explicit runs separate batches',async t=>{
  const {core}=await fixture(t)
  const made=await core.createBlock('Home',{type:'list',items:['First','Second']})
  const second=block(core,made.blockId).items[1]
  core.beginAgentRun()
  await core.updateBlock(made.blockId,{add_items:['Third']},'list')
  await core.editText({blockId:made.blockId,itemId:second.id,text:'Keep this correction'})
  const later=await core.addCapture('Keep this new note')
  await core.undo()
  assert.deepEqual(block(core,made.blockId).items.map(i=>i.text),['First','Keep this correction'])
  assert.ok(core.project().captures.some(c=>c.id===later.id))
})
test('undo refuses a newer edit to the same field without partially reverting the batch',async t=>{
  const {core}=await fixture(t)
  const made=await core.createBlock('Plan',{type:'note',text:'Original'})
  core.beginAgentRun()
  await core.updateBlock(made.blockId,{note_text:'Agent draft'},'note')
  await core.createBlock('Other',{type:'note',text:'Another part of the batch'})
  await core.editText({blockId:made.blockId,text:'My newer wording'})
  const before=JSON.stringify(core.project())
  await assert.rejects(core.undo(),/newer work/)
  assert.equal(JSON.stringify(core.project()),before)
  assert.equal(core.project().canUndo,true)
})
test('retire undo restores one copy and preserves independent new content',async t=>{
  const {core}=await fixture(t)
  const made=await core.createBlock('Reading',{type:'note',text:'A book'})
  await core.retireSpace(made.spaceId)
  const later=await core.addCapture('Keep me')
  await core.undoManual()
  assert.equal(core.project().spaces.filter(s=>s.id===made.spaceId).length,1)
  assert.equal(core.project().retired.some(s=>s.id===made.spaceId),false)
  assert.ok(core.project().captures.some(c=>c.id===later.id))
})
test('failed undo can be persisted on retry without applying its inverse twice',async t=>{
  const {core,dir}=await fixture(t)
  const made=await core.createBlock('Home',{type:'list',items:['First','Second']})
  const first=block(core,made.blockId).items[0]
  await core.check(made.blockId,first.id,true)
  const fault=join(dir,'state.json.writing');await mkdir(fault)
  await assert.rejects(core.undoManual())
  await rm(fault,{recursive:true})
  const later=await core.addCapture('Added after the failed undo')
  await core.undoManual()
  assert.equal(block(core,made.blockId).items[0].done,false)
  assert.ok(core.project().captures.some(c=>c.id===later.id))
  assert.equal(core.canUndoManual(),false)
})
test('amount receipt shares the write, survives restart, and retries concurrent/failed writes once',async t=>{
  let {core,dir}=await fixture(t)
  const capture=await core.addCapture('Paid 45 for dinner')
  const made=await core.createBlock('Food',{type:'ledger',entries:[]})
  const args={blockId:made.blockId,source:capture.id,label:'Dinner',amount:45}
  const apply=()=>operation(core,'december_log_amount',args,()=>core.updateBlock(made.blockId,{entry_label:'Dinner',entry_amount:45,source:capture.id},'ledger'))
  const fault=join(dir,'state.json.writing');await mkdir(fault)
  await assert.rejects(apply())
  await rm(fault,{recursive:true})
  const [first,second]=await Promise.all([apply(),apply()])
  assert.deepEqual(second,first)
  assert.equal(block(core,made.blockId).entries.length,1)
  const saved=JSON.parse(await readFile(join(dir,'state.json'),'utf8'))
  assert.equal(saved.operations.length,1)
  assert.equal(saved.spaces[0].blocks[0].entries.length,1)
  core=await load(dir)
  assert.deepEqual(await apply(),first)
  assert.equal(block(core,made.blockId).entries.length,1)
  assert.equal(core.agentView().captures[0].appliedOperations[0].result.blockId,made.blockId)
})
test('explicit identities allow separate identical expenses and reject argument reuse',async t=>{
  const {core}=await fixture(t)
  const capture=await core.addCapture('Two separate 45 dollar expenses')
  const made=await core.createBlock('Food',{type:'ledger',entries:[]})
  const apply=(operationId,amount=45)=>operation(core,'december_log_amount',{operationId,source:capture.id,blockId:made.blockId,label:'Dinner',amount},()=>core.updateBlock(made.blockId,{entry_label:'Dinner',entry_amount:amount},'ledger'))
  await apply('first');await apply('second');await apply('first')
  assert.equal(block(core,made.blockId).entries.length,2)
  await assert.rejects(apply('first',90),/different arguments/)
  assert.equal(block(core,made.blockId).entries.length,2)
})
test('undo tombstones receipts so an old retry cannot resurrect the undone operation',async t=>{
  let {core,dir}=await fixture(t)
  const capture=await core.addCapture('Paid 45')
  const made=await core.createBlock('Food',{type:'ledger',entries:[]})
  core.beginAgentRun()
  const args={source:capture.id,blockId:made.blockId,label:'Food',amount:45}
  const apply=()=>operation(core,'december_log_amount',args,()=>core.updateBlock(made.blockId,{entry_label:'Food',entry_amount:45},'ledger'))
  await apply();await core.undo()
  assert.equal(block(core,made.blockId).entries.length,0)
  await assert.rejects(apply(),/was undone/)
  core=await load(dir)
  await assert.rejects(apply(),/was undone/)
})
test('file capture replay keeps a single activity entry and rejects new work for a filed capture',async t=>{
  const {core}=await fixture(t)
  const capture=await core.addCapture('A note')
  const args={captureId:capture.id,space:'Home',summary:'Saved note'}
  const apply=()=>operation(core,'december_file_capture',args,()=>core.fileCapture(capture.id,args.space,args.summary))
  await apply();await apply();await core.fileCapture(capture.id,args.space,args.summary)
  assert.equal(core.project().activity.length,1)
  await assert.rejects(operation(core,'december_create_block',{source:capture.id,space:'Home',type:'note',text:'Duplicate'},()=>assert.fail()),/already filed/)
})
test('actual tool dispatcher replays creation, deltas, appends, and recovery after rollover',async t=>{
  const {dir}=await fixture(t)
  const script=`
    const {callTool}=await import('./lib/tools.mjs');const core=await import('./lib/core.mjs');
    const c=await core.addCapture('Make my page');
    const create={source:c.id,space:'Home',type:'tracker',current:0,target:20};
    const first=await callTool('december_create_block',create),again=await callTool('december_create_block',create);
    if(first.blockId!==again.blockId)throw Error('duplicate creation');
    const delta={source:c.id,blockId:first.blockId,delta:3};await callTool('december_move_tracker',delta);await callTool('december_move_tracker',delta);
    if(core.readBlock(first.blockId).block.current!==3)throw Error('duplicate delta');
    const list=await callTool('december_create_block',{source:c.id,space:'Home',type:'list',items:[]});
    const add={source:c.id,blockId:list.blockId,add:['Milk']};await callTool('december_add_or_check',add);await callTool('december_add_or_check',add);
    if(core.readBlock(list.blockId).block.items.length!==1)throw Error('duplicate list item');
    const note=await callTool('december_create_block',{source:c.id,space:'Home',type:'note',text:'First'});
    const append={source:c.id,blockId:note.blockId,text:'Second',mode:'append'};await callTool('december_write_note',append);await callTool('december_write_note',append);
    if(core.readBlock(note.blockId).block.text!=='First\\nSecond')throw Error('duplicate append');
    await core.rolloverIfNeeded(new Date(new Date().getFullYear()+1,0,1));
    if((await callTool('december_create_block',create)).blockId!==first.blockId)throw Error('rollover lost receipt');
    if(core.project().spaces.length)throw Error('replay created a new-year block');
  `
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,DECEMBER_DATA_DIR:dir},encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
})
test('a complete agent-created card with an area can be undone without removing later notes',async t=>{
  const {core}=await fixture(t)
  const request=await core.addCapture('Remember a book')
  core.beginAgentRun()
  const made=await core.createBlock('Reading',{type:'note',text:'Piranesi'})
  await core.setArea(made.spaceId,'Learning')
  await core.fileCapture(request.id,made.spaceId,'Saved book')
  const later=await core.addCapture('An unrelated later thought')
  await core.undo()
  assert.equal(core.project().spaces.length,0)
  assert.ok(core.project().captures.some(c=>c.id===request.id))
  assert.ok(core.project().captures.some(c=>c.id===later.id))
})

test('legacy identity-free tool additions remain separate writes while identified retries deduplicate',async t=>{
  const {dir}=await fixture(t)
  const script=`
    const {callTool}=await import('./lib/tools.mjs');const core=await import('./lib/core.mjs');
    const made=await callTool('december_create_block',{space:'Budget',type:'ledger',entries:[]});
    const args={blockId:made.blockId,label:'Lunch',amount:12};
    await callTool('december_log_amount',args);await callTool('december_log_amount',args);
    if(core.readBlock(made.blockId).block.entries.length!==2)throw Error('legacy calls lost');
    const identified={...args,operationId:'intentional-third'};
    await callTool('december_log_amount',identified);await callTool('december_log_amount',identified);
    const entries=core.readBlock(made.blockId).block.entries;
    if(entries.length!==3 || entries.reduce((n,e)=>n+e.amount,0)!==36)throw Error('identified retry duplicated');
  `
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),env:{...process.env,DECEMBER_DATA_DIR:dir},encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
})
