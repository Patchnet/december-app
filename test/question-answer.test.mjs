import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
let n=0
const load=async dir=>{process.env.DECEMBER_DATA_DIR=dir;return import(`../lib/core.mjs?question=${++n}`)}
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'december-question-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {core:await load(dir),dir}}
test('stale answer and dismissal leave the new question and inbox unchanged',async t=>{
  const {core}=await fixture(t)
  await core.setAsk('What time?',[]);const a=core.project().ask.id
  await core.setAsk('Which day?',[]);const b=core.project().ask.id
  for(const choice of ['Friday',''])await assert.rejects(core.answerAsk({askId:a,choice,typed:true}),error=>error.statusCode===409)
  await assert.rejects(core.answerAsk({choice:'Monday'}),error=>error.statusCode===409)
  assert.equal(core.project().ask.id,b);assert.equal(core.project().captures.length,0)
})
test('response and question consumption persist together; replay preserves a newer question',async t=>{
  let {core,dir}=await fixture(t)
  await core.setAsk('What time is the appointment?',[])
  const askId=core.project().ask.id,args={askId,choice:'3 pm',typed:true}
  const first=await core.answerAsk(args)
  const saved=JSON.parse(await readFile(join(dir,'state.json'),'utf8'))
  assert.equal(saved.ask,null);assert.equal(saved.captures[0].id,first.captureId)
  assert.equal(saved.captures[0].text,'What time is the appointment? 3 pm')
  core=await load(dir);await core.setAsk('Who is coming?',[])
  const next=core.project().ask.id
  assert.equal((await core.answerAsk(args)).captureId,first.captureId)
  assert.equal(core.project().ask.id,next);assert.equal(core.project().captures.length,1)
  await assert.rejects(core.answerAsk({...args,choice:'4 pm'}),/different response/)
})
test('failed persistence is retried without duplicating the answer or clearing a later ask',async t=>{
  const {core,dir}=await fixture(t)
  await core.setAsk('Which date?',[]);const args={askId:core.project().ask.id,choice:'Friday',typed:true}
  const fault=join(dir,'state.json.writing');await mkdir(fault)
  await assert.rejects(core.answerAsk(args));await rm(fault,{recursive:true})
  await core.setAsk('Which place?',[]);const next=core.project().ask.id
  const result=await core.answerAsk(args)
  assert.equal(result.duplicate,true);assert.equal(core.project().captures.length,1);assert.equal(core.project().ask.id,next)
  const restarted=await load(dir);assert.equal(restarted.project().captures.length,1)
})
test('invalid or over-capacity answers preserve the question; dismissal remains possible',async t=>{
  const {core}=await fixture(t)
  await core.setAsk('What time?',[]);const askId=core.project().ask.id
  await assert.rejects(core.answerAsk({askId,choice:'x'.repeat(9000),typed:true}))
  assert.equal(core.project().ask.id,askId)
  for(let i=0;i<200;i++)await core.addCapture(`Note ${i}`)
  await assert.rejects(core.answerAsk({askId,choice:'3 pm',typed:true}))
  assert.equal(core.project().ask.id,askId)
  const receipt=await core.answerAsk({askId})
  assert.equal(receipt.captureId,null);assert.equal(core.project().ask,null)
})
