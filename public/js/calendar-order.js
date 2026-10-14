export function localDayAfter(days,now=new Date()) {
  const date=new Date(now)
  date.setDate(date.getDate()+days)
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
// Equal text is not identity: independent appointments must both remain.
export function reminderIdentity(space,block) {return `${space.id}:${block.id}`}
