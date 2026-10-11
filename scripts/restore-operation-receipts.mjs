// Offline downgrade preparation: writes a NEW state file, never replaces the
// person's page. Stop December before installing the resulting file.
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
const [statePath,archivePath,outputPath]=process.argv.slice(2)
if(!statePath || !archivePath || !outputPath)throw new Error('Usage: node scripts/restore-operation-receipts.mjs STATE ARCHIVE NEW_OUTPUT')
if([statePath,archivePath].some(path=>resolve(path)===resolve(outputPath)))throw new Error('Output must be a new file')
const state=JSON.parse(await readFile(statePath,'utf8'))
const archive=JSON.parse(await readFile(archivePath,'utf8'))
if(!Array.isArray(archive)||!Array.isArray(state.operations))throw new Error('Invalid receipt data')
const receipts=new Map()
for(const receipt of [...archive,...state.operations]) {
  if(!receipt?.id||!receipt.signature||!['applied','undone'].includes(receipt.status))throw new Error('Invalid receipt')
  const previous=receipts.get(receipt.id)
  if(previous && previous.signature!==receipt.signature)throw new Error('Conflicting receipt signatures')
  receipts.set(receipt.id,receipt)
}
state.operations=[...receipts.values()]
delete state.operationArchiveRequired
await writeFile(outputPath,JSON.stringify(state),{flag:'wx'})
console.log('Wrote a new state file with',state.operations.length,'receipts. Keep the original state and archive as backups.')
