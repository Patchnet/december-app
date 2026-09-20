import { markEdited } from './motion.js'

// Use the same soft edit emphasis in compact cards and the open card.
// Snapshot comparisons indicate changed fields, not an inferred agent action.
export function highlightCardChanges(card, before, after) {
  if (!card || !before || document.hidden) return
  const mark = selector => markEdited(card.querySelector(selector))
  if (before.name !== after.name) mark('.space-name, .solo-sub')
  const old = new Map(before.blocks.map(block=>[block.id,block]))
  for (const block of after.blocks) {
    const previous = old.get(block.id)
    if (!previous || previous.type !== block.type) continue
    const root = card.querySelector(`[data-bid="${CSS.escape(block.id)}"]`)
    const solo = after.blocks.length === 1 && card.querySelector('.solo')
    if (block.type === 'note' || block.type === 'reminder') {
      if (previous.text !== block.text) markEdited(solo ? card.querySelector('.solo-text') : root?.querySelector('.note-text, .row-text'))
      if (['when','at','repeat'].some(field=>previous[field] !== block[field])) {
        markEdited(solo ? card.querySelector('.solo-sub') || card.querySelector('.solo-text') : root?.querySelector('.when-sub, .place-chip') || root?.querySelector('.row-text'))
      }
    }
    if (block.type === 'list') {
      const items = new Map(previous.items.map(item=>[item.id,item]))
      for (const item of block.items) if (items.has(item.id) && items.get(item.id).text !== item.text) {
        markEdited(root?.querySelector(`[data-item="${CSS.escape(item.id)}"] .row-text`))
      }
    }
  }
}

// A local acknowledgement for newly filed list items. WAAPI survives a poll
// reconciling the row's class attribute; the same row never restarts its cue.
const arrivals = new WeakSet()
export function showAddedItem(row) {
  if (!row || arrivals.has(row) || document.hidden) return
  arrivals.add(row)
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const tint = getComputedStyle(row).getPropertyValue('--accent-soft').trim() || 'rgba(61,168,220,.12)'
  row.animate([
    { opacity: reduced ? 1 : .2, backgroundColor: tint },
    { opacity: 1, backgroundColor: tint, offset: .25 },
    { opacity: 1, backgroundColor: tint, offset: .65 },
    { opacity: 1, backgroundColor: 'transparent' },
  ], { duration: reduced ? 900 : 1600, easing: 'ease-out' })
}
