import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('capture timing waits for an acknowledged, filed capture and records one paint opportunity', async () => {
  const source = (await readFile(new URL('../public/js/capture-timing.js',import.meta.url),'utf8')).replaceAll('export function','function')
  const panel={textContent:''}, frames=[]
  const context=vm.createContext({document:{hidden:false,querySelector:()=>panel},performance:{now:()=>450},requestAnimationFrame:f=>frames.push(f)})
  vm.runInContext(source,context)
  vm.runInContext("startCaptureTiming('request',100); acknowledgeCaptureTiming({requestId:'wrong',captureIds:['c']}); measureCapturePaint({captures:[],activity:[{captureId:'c'}]})",context)
  assert.equal(frames.length,0)
  vm.runInContext("acknowledgeCaptureTiming({requestId:'request',captureIds:['c']}); measureCapturePaint({captures:[{id:'c'}],activity:[]})",context)
  assert.equal(frames.length,0)
  vm.runInContext("measureCapturePaint({captures:[],activity:[{captureId:'c'}]},1)",context)
  assert.equal(frames.length,0)
  vm.runInContext("measureCapturePaint({captures:[],settle:{running:true},activity:[],filedCaptureIds:['c']})",context)
  frames.shift()()
  assert.equal(panel.textContent,'')
  frames.shift()()
  assert.match(panel.textContent,/350 ms/)
  vm.runInContext("measureCapturePaint({captures:[],activity:[{captureId:'c'}]})",context)
  assert.equal(frames.length,0)
})
