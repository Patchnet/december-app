import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {once} from 'node:events'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

async function fixture(t,{engine=false}={}) {
  const root=fileURLToPath(new URL('..',import.meta.url))
  const dir=await mkdtemp(join(tmpdir(),'december-agent-http-'))
  const binary=join(dir,'fake-claude.mjs')
  if(engine){
    await writeFile(binary,`#!/usr/bin/env node
import {readFileSync} from 'node:fs'
import {createInterface} from 'node:readline'
if(process.argv.includes('--version')){console.log('fixture');process.exit(0)}
const config=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1],'utf8')).mcpServers.december.env
const headers={'content-type':'application/json','x-december-access':config.DECEMBER_ACCESS,'x-december-organizer-token':config.DECEMBER_ORGANIZER_TOKEN}
const tool=async(name,args={})=>{
 const response=await fetch(config.DECEMBER_URL+'/api/tool',{method:'POST',headers,body:JSON.stringify({name,arguments:args})})
 const body=await response.json();if(!response.ok)throw new Error(body.error);return body.result
}
createInterface({input:process.stdin}).on('line',async()=>{
 try {
  const view=await tool('december_view')
  for(const capture of view.captures){
   const space=await tool('december_create_space',{name:'Inbox notes',source:capture.id})
   const made=await tool('december_create_block',{space:space.id,type:'note',text:capture.text,source:capture.id,operationId:'note'})
   const read=await tool('december_read_block',{blockId:made.blockId})
   const edit={blockId:made.blockId,text:'.',mode:'append',source:capture.id,operationId:'edit',expectedVersion:read.version}
   const result=await tool('december_write_note',edit)
   if(!result.version)throw new Error('Missing mutation version')
   await tool('december_write_note',edit)
   await tool('december_file_capture',{captureId:capture.id,space:space.id,summary:'Saved',operationId:'file'})
  }
  console.log(JSON.stringify({type:'result',subtype:'success',result:'Done'}))
 }catch(e){console.log(JSON.stringify({type:'result',is_error:true,result:e.message}))}
})
`)
    await writeFile(join(dir,'bootstrap.mjs'),`import {ENGINES} from ${JSON.stringify(new URL('../lib/settings.mjs',import.meta.url).href)};
ENGINES.claude.prefixArgs=[${JSON.stringify(binary)}];
await import(${JSON.stringify(new URL('../server.mjs',import.meta.url).href)});
`)
  }
  const probe=createServer().listen(0,'127.0.0.1');await once(probe,'listening')
  const port=probe.address().port;probe.close();await once(probe,'close')
  const child=spawn(process.execPath,[engine?join(dir,'bootstrap.mjs'):'server.mjs'],{cwd:root,stdio:'pipe',env:{...process.env,PORT:String(port),DECEMBER_DATA_DIR:dir,
    DECEMBER_CLAUDE:engine?process.execPath:join(dir,'missing'),DECEMBER_CODEX:join(dir,'missing'),
    DECEMBER_JEV_MODE:'fast',DECEMBER_JEV_FIXTURE:'1',TYPESAFE_API_KEY:'obsolete-value-that-must-never-be-used'}})
  const exit=once(child,'exit');let log=''
  child.stdout.on('data',c=>{log+=c});child.stderr.on('data',c=>{log+=c})
  const abort=new AbortController()
  t.after(async()=>{abort.abort();child.kill('SIGTERM');await exit;await rm(dir,{recursive:true,force:true});for(const name of [`mcp.${port}.json`,`mcp.read.${port}.json`])await rm(join(root,name),{force:true})})
  for(let n=0;n<150&&!log.includes('december listening');n++)await new Promise(r=>setTimeout(r,20))
  assert.match(log,/december listening/)
  const base=`http://127.0.0.1:${port}`
  const api=async(path,body,headers={})=>{
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined})
    return {status:response.status,body:await response.json()}
  }
  return {base,api,abort}
}

test('Jev-free server pushes durable changes, preserves capture-only mode and enforces read-only MCP',async t=>{
  const {base,api,abort}=await fixture(t)
  const stream=await fetch(base+'/api/changes',{signal:abort.signal})
  assert.equal(stream.status,200)
  const reader=stream.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value),/connected/)
  const capture=await api('/api/capture',{text:'Add oat milk',requestId:'retained'})
  assert.equal(capture.body.settle.jev.mode,'off')
  assert.equal(capture.body.settle.captureOnly,true)
  assert.equal(capture.body.captures.length,1)
  assert.match(new TextDecoder().decode((await reader.read()).value),/revision/)
  const headers={'x-december-access':'read'}
  const catalog=await api('/api/tools',undefined,headers)
  assert.deepEqual(catalog.body.tools.map(t=>t.name).sort(),['december_query','december_read_block','december_read_space','december_view'])
  const denied=await api('/api/tool',{name:'december_create_space',arguments:{name:'Forbidden'}},headers)
  assert.match(denied.body.error,/read-only/)
  assert.equal((await api('/api/state')).body.spaces.length,0)
  assert.equal((await api('/api/tool',{name:'december_view'},{'x-december-access':'organizer'})).status,403)
})

test('real server scheduler drains multiple fixed batches through a disposable streaming engine',async t=>{
  const {api}=await fixture(t,{engine:true})
  const receipt=await api('/api/capture',{text:Array.from({length:12},(_,i)=>`Note ${i}`).join('\n'),requestId:'batch'})
  assert.equal(receipt.status,200)
  let page
  for(let n=0;n<150;n++) {
    page=(await api('/api/state')).body
    if(!page.captures.length&&!page.settle.running)break
    await new Promise(r=>setTimeout(r,30))
  }
  assert.equal(page.captures.length,0,JSON.stringify(page.settle))
  assert.equal(page.spaces[0].blocks.length,12)
  assert.ok(page.settle.timings.pass.count>=2)
  assert.equal(new Set(page.spaces[0].blocks.map(b=>b.text)).size,12)
  assert.equal(page.settle.lastError,null)
})
