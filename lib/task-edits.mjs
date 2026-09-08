import {createHash} from 'node:crypto'
import {makeBlock} from './blocks.mjs'

export function scheduleSignature(args) {
  return createHash('sha256').update(JSON.stringify([
    args.blockId,args.itemId,args.when,args.at ?? '',args.repeat ?? '',
    args.text ?? null,args.source ?? '',args.entities ?? null,args.watch ?? false,
  ])).digest('hex')
}

/** Prepare a move without mutating the source task or its siblings. */
export function scheduledItem(list,item,args) {
  if (item.done) throw new Error('This task is already completed. Reopen it before scheduling it.')
  if (args.done !== undefined && args.done !== false) throw new Error('Scheduling a task does not complete it.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.when || '') || Number.isNaN(Date.parse(args.when)) || new Date(args.when).toISOString().slice(0,10) !== args.when) throw new Error('Give this task a valid date in YYYY-MM-DD format.')
  if (args.at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(args.at)) throw new Error('Give a valid clock time in HH:MM format.')
  if (args.repeat && !['daily','weekly','monthly','yearly'].includes(args.repeat)) throw new Error('Unknown recurrence.')
  const text = args.text === undefined ? item.text : args.text
  if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('Task wording must be between 1 and 200 characters.')
  const reminder=makeBlock({type:'reminder',title:'',text,when:args.when,at:args.at,repeat:args.repeat,entities:args.entities ?? list.entities,watch:args.watch})
  reminder.src=args.source || item.src || ''
  const listFields=structuredClone(list)
  delete listFields.items
  reminder.movedFrom={blockId:list.id,listFields,item:structuredClone(item),signature:scheduleSignature(args)}
  return reminder
}
