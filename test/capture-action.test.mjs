import {test} from 'node:test'
import assert from 'node:assert/strict'
import {captureAction,commitCaptureAction} from '../lib/capture-action.mjs'
const lists=[{id:'list',spaceId:'space'}]
test('structured actions compile only supported verbs and preserve source identity',async()=>{
 const action=captureAction({action:'append',target:'list',items:['milk','bread']},lists,'capture')
 const calls=[];await commitCaptureAction(action,async(name,args)=>{calls.push({name,args})})
 assert.equal(calls[0].name,'december_add_or_check');assert.deepEqual(calls[0].args.add,['milk','bread'])
 assert.equal(calls[1].name,'december_file_capture');assert.equal(calls[1].args.space,'space')
 assert.equal(calls[0].args.source,calls[1].args.source)
 assert.throws(()=>captureAction({action:'delete'},lists,'capture'),/Unsupported/)
 assert.throws(()=>captureAction({action:'append',target:'missing',item:'milk'},lists,'capture'),/Invalid/)
})
test('failed mutations never file and missing destination leaves capture recoverable',async()=>{
 const action=captureAction({action:'create',name:'Garden',items:['water','weed']},[],'c');let calls=0
 await assert.rejects(commitCaptureAction(action,async()=>{calls++;throw new Error('disk')}),/disk/);assert.equal(calls,1)
 calls=0;await assert.rejects(commitCaptureAction(action,async()=>{calls++;return {}}),/no destination/);assert.equal(calls,1)
})
