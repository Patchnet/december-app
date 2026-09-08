import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {createAgentProcess} from '../lib/agent-process.mjs'
function harness(binary='fixture') {
  const children=[],readers=[]
  const spawn=(executable)=>{
    const proc=new EventEmitter();proc.binary=executable;proc.stdin=new EventEmitter();proc.stderr=new EventEmitter();proc.stdout={}
    proc.stdin.write=value=>{proc.input=value};proc.kill=()=>{proc.killed=true};children.push(proc);return proc
  }
  const createInterface=()=>{const reader=new EventEmitter();reader.close=()=>{reader.closed=true};readers.push(reader);return reader}
  return {children,readers,runner:createAgentProcess({binary,args:model=>[model],cwd:'/tmp',spawn,createInterface})}
}
test('late exit, error, stderr and result from a retired child cannot touch its replacement',async()=>{
  const h=harness();h.runner.ensure('a')
  const old=h.runner.turn('old',5000);const rejected=assert.rejects(old,/stopped/)
  h.runner.stop();await rejected
  assert.equal(h.readers[0].closed,true)
  h.runner.ensure('b');const next=h.runner.turn('new',5000)
  h.children[0].stderr.emit('data','old noise');h.children[0].emit('exit');h.children[0].emit('error',new Error('old error'))
  h.children[0].stdin.emit('error',new Error('old input'));h.readers[0].emit('line',JSON.stringify({type:'result',result:'old'}))
  assert.equal(h.runner.state.proc,h.children[1])
  h.readers[1].emit('line',JSON.stringify({type:'result',subtype:'success',result:'new'}))
  assert.equal((await next).result,'new')
  h.runner.stop()
})
test('timeout rejects only its turn, closes its reader and permits a fresh process',async()=>{
  const h=harness();h.runner.ensure('a')
  await assert.rejects(h.runner.turn('late',5),/timed out/)
  assert.equal(h.children[0].killed,true);assert.equal(h.readers[0].closed,true)
  h.runner.ensure('a');const next=h.runner.turn('new',5000)
  h.readers[0].emit('line',JSON.stringify({type:'result'}))
  h.readers[1].emit('line',JSON.stringify({type:'result',result:'new'}))
  assert.equal((await next).result,'new');h.runner.stop()
})
test('provider result errors, stdin errors and overlapping turns fail explicitly',async()=>{
  const h=harness();h.runner.ensure('a')
  const first=h.runner.turn('first',5000)
  await assert.rejects(h.runner.turn('overlap',5000),/active turn/)
  h.readers[0].emit('line',JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true,errors:['limit reached']}))
  await assert.rejects(first,/limit reached/)
  h.runner.ensure('a');const second=h.runner.turn('second',5000)
  h.children[1].stdin.emit('error',new Error('broken pipe'))
  await assert.rejects(second,/broken pipe/)
  assert.equal(h.runner.state.proc,null)
})

test('changing the configured executable replaces the process without requiring an app restart',async()=>{
  let binary='first-cli'
  const h=harness(()=>binary);h.runner.ensure('model')
  assert.equal(h.children[0].binary,'first-cli')
  binary='replacement-cli';h.runner.ensure('model')
  assert.equal(h.children[0].killed,true)
  assert.equal(h.children[1].binary,'replacement-cli')
  const turn=h.runner.turn('new configuration',5000)
  h.children[0].emit('exit')
  h.readers[1].emit('line',JSON.stringify({type:'result',result:'new'}))
  assert.equal((await turn).result,'new');h.runner.stop()
})
