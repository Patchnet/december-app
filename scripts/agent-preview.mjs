// Disposable, provider-neutral preview. Never points at the person's page and
// never launches an organizing engine or a background model call.
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
process.env.DECEMBER_DATA_DIR=await mkdtemp(join(tmpdir(),'december-preview-'))
process.env.DECEMBER_AGENT_FIXTURE='1'
process.env.DECEMBER_CLAUDE=join(process.env.DECEMBER_DATA_DIR,'no-engine')
process.env.DECEMBER_CODEX=process.env.DECEMBER_CLAUDE
const at=new Date().toISOString()
await writeFile(join(process.env.DECEMBER_DATA_DIR,'state.json'),JSON.stringify({yearOf:new Date().getFullYear(),spaces:[
  {id:'groceries',name:'Groceries',area:'Home',createdAt:at,updatedAt:at,blocks:[{id:'shopping',type:'list',title:'',items:[{id:'eggs',text:'Eggs',done:false},{id:'bread',text:'Bread',done:false}]}]},
  {id:'garden',name:'Garden',area:'Home',createdAt:at,updatedAt:at,blocks:[{id:'garden-note',type:'note',title:'',text:'Water the herbs in the morning.'}]},
]}))
console.log('Synthetic preview data:',process.env.DECEMBER_DATA_DIR)
await import('../server.mjs')
