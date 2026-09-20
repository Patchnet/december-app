import { submitAnswer } from './question-input.js'
import { $, toast, api, page, hooks, reduced, adoptState } from './session.js'
import { whenPhrase } from './blocks.js'
import { commitTick, clearCommitTick } from './commit-tick.js'
import { drawCompletion, clearInk } from './ink-feedback.js'
import { pop, withFlip, celebrateSpace, markEdited, bump } from './motion.js'
import { buildFocus, closeFocus, askToFinish, resortCard, settleCard } from './layout.js'
import { holdCard, releaseCard, cardHeld } from './completion-motion.js'
import { finishCardShape } from './card-shape.js'
import { renderToday } from './attention.js'
import { settleFrom } from './pending-stage.js'
import { openDayPicker } from './day-picker.js'
import { openPastYear, buildYear, openMonth, renderCarryover, renderCarryoverNudge, coAnswer, coCommit, coCount, parkCarryover } from './year.js'
// Task focus listens in the capture phase, so it decides what a click on the
// words of a row means before anything below gets to check the row off.
import './focus-task.js'
import './disclosure-motion.js'
// A check keeps its key until its card has visibly settled, so a second tap
// on the same row is ignored rather than raced against the first.
const pendingChecks=new Set()
// The brush tick draws for 583ms and the row rests a breath under it. An
// uncheck has only its words to bring back. The request leaves at the click
// either way; this is never added to the network's time, only outlasted.
const CHECK_MOMENT=620,UNCHECK_MOMENT=220,STILL_MOMENT=160
// Rows whose moment is over while another check still owns their card. The
// last check to let go settles them all, once, from the latest confirmed state.
const settling=new Map()

/** One check lets go of its card. `moves` says the row now has a new place. */
function leaveMoment(sid,key,moves) {
  const keys=settling.get(sid) || new Set()
  if(moves)keys.add(key)
  else pendingChecks.delete(key)
  if(releaseCard(sid)){settling.set(sid,keys);return 'held'}
  settling.delete(sid)
  if(!keys.size)return 'free'
  const free=()=>{for(const settled of keys)pendingChecks.delete(settled)}
  let rest
  try{rest=settleCard(sid,[...keys])}finally{(rest || Promise.resolve()).then(free,free)}
  // the day's line turns in the same breath as the card, not a poll later
  renderToday()
  return 'settled'
}
// A completion the agent confirmed shares this bookkeeping: it claims the
// row's key, so the hand cannot race it, and lets go the way a check does.
hooks.completionMoment={
  claim(key){if(pendingChecks.has(key))return false;pendingChecks.add(key);return true},
  leave:leaveMoment,
}

document.addEventListener('toggle', (e) => {
  const fold = e.target
  if (!fold.matches?.('[data-list-preview]') || !fold.isConnected) return
  if (fold.open) page.expandedLists.add(fold.dataset.listPreview)
  else page.expandedLists.delete(fold.dataset.listPreview)
}, true)

document.addEventListener('click', async (e) => {
  // a link in a card is a link: let the browser have it
  if (e.target.closest('a.card-link')) return

  // a long note unfolds
  const note = e.target.closest('.note-text.clamp')
  if (note) {
    note.classList.toggle('open')
    return
  }

  const confirmFin = e.target.closest('[data-confirm-finish]')
  if (confirmFin) {
    const id = confirmFin.dataset.confirmFinish
    $('#focus').dataset.confirm = ''
    $('#focus').innerHTML = ''
    const btn = document.querySelector(`.space[data-sid="${id}"] [data-finish]`)
    if (btn) {
      btn.dataset.confirmed = '1'
      btn.click()
      btn.dataset.confirmed = ''
      return
    }
    // a goal-only space has no card to click through: archive it directly,
    // and the send-off lands on its row in the band — its place on the page
    if (!reduced) celebrateSpace(document.querySelector(`#goals [data-goal-open="${id}"]`))
    try {
      const out = await api('/api/finish', { spaceId: id, finished: true })
      adoptState(out.state)
      page.focusId = null
      hooks.render()
      toast(`${out.name} archived`)
    } catch (err) {
      toast(err.message)
    }
    return
  }

  const pinBtn = e.target.closest('[data-pin]')
  if (pinBtn) {
    const sp = page.state.spaces.find((x) => x.id === pinBtn.dataset.pin)
    try {
      const out = await api('/api/pin', { spaceId: pinBtn.dataset.pin, pinned: !sp?.pinned })
      adoptState(out.state)
      withFlip(() => hooks.render())
      // a card inside a completion's moment takes the pin when it settles
      if (page.focusId && !cardHeld(page.focusId)) buildFocus()
      toast(out.pinned ? `${out.name} pinned` : `${out.name} unpinned`)
    } catch (err) {
      toast(err.message)
    }
    return
  }
  const finBtn = e.target.closest('[data-finish]')
  if (finBtn) {
    const sp = page.state.spaces.find((x) => x.id === finBtn.dataset.finish)
    // done work closes instantly; unfinished work has to be looked at first
    if (!sp?.finished && !sp?.complete && !finBtn.dataset.confirmed) {
      askToFinish(sp)
      return
    }
    const el = document.querySelector(`.space[data-sid="${finBtn.dataset.finish}"]`)
    if (!sp?.finished && el && !reduced) celebrateSpace(el)
    try {
      const out = await api('/api/finish', { spaceId: finBtn.dataset.finish, finished: !sp?.finished })
      adoptState(out.state)
      if (out.finished) {
        await leaveArchived(finBtn.dataset.finish)
        toast(`${out.name} archived`)
        return
      }
      hooks.render()
      toast(`${out.name} reopened`)
    } catch (err) {
      toast(err.message)
    }
    return
  }
  const reopen = e.target.closest('[data-reopen]')
  if (reopen) {
    try {
      const out = await api('/api/finish', { spaceId: reopen.dataset.reopen, finished: false })
      adoptState(out.state)
      withFlip(() => hooks.render())
      toast(`${out.name} reopened`)
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // restoring a space set aside before closing out replaced retiring
  const rest = e.target.closest('[data-restore]')
  if (rest) {
    try {
      const out = await api('/api/restore', { spaceId: rest.dataset.restore })
      adoptState(out.state)
      withFlip(() => hooks.render())
      toast(`${out.name} is back`)
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // the foot of the page: open one group, which closes any other
  const grp = e.target.closest('[data-grp]')
  if (grp) {
    page.restOpen = page.restOpen === grp.dataset.grp ? '' : grp.dataset.grp
    hooks.render()
    return
  }

  // wake a resting space
  const wake = e.target.closest('[data-wake]')
  if (wake) {
    page.awake.add(wake.dataset.wake)
    hooks.render()
    return
  }

  // suggestion chip: the sentence files as if typed; the set retires with it
  const sug = e.target.closest('[data-suggest]')
  if (sug) {
    // a picked chip is spent: a second click inside the send window would
    // file the same sentence twice (and a doubled "went to the gym" would
    // move a goal by two)
    if (sug.classList.contains('picked')) return
    sug.classList.add('picked')
    sug.closest('.chips')?.classList.add('spent')
    settleFrom(sug.getBoundingClientRect())
    const text = sug.dataset.suggest
    setTimeout(async () => {
      try {
        adoptState(await api('/api/capture', { text }))
        page.state.suggestions = []
        hooks.render()
        hooks.schedulePoll()
        api('/api/tool', { name: 'december_suggest', arguments: { suggestions: [] } }).catch(() => {})
      } catch (err) {
        toast(err.message)
      }
    }, 200)
    return
  }

  // Capture identity from the displayed question, before any async work.
  const ans=e.target.closest('[data-answer]')
  if(ans){void submitAnswer(ans,ans.dataset.answer);return}
  const dismiss=e.target.closest('[data-dismiss]')
  if(dismiss){void submitAnswer(dismiss,'');return}
  // a goal opens its space: the row is the space's presence on the page,
  // so clicking it gives the full card — log, tick, pin, archive
  const gopen = e.target.closest('[data-goal-open]')
  if (gopen) {
    e.preventDefault()
    page.focusId = gopen.dataset.goalOpen
    buildFocus()
    return
  }

  // rail: jump to a space — navigation gets the light touch (border only),
  // never the full agent-touched sheen
  const jump = e.target.closest('[data-jump]')
  if (jump) {
    e.preventDefault()
    jumpToSpace(jump.dataset.jump)
    return
  }

  // closing the focus view: backdrop or wrapper, never the card itself
  if (e.target.dataset?.close !== undefined) {
    closeFocus()
    return
  }

  // a month on the year opens; the month walks back to it
  const mo = e.target.closest('[data-month]')
  if (mo) {
    openMonth(mo.dataset.month)
    return
  }
  if (e.target.closest('[data-back-to-year]')) {
    buildYear()
    return
  }

  const yj = e.target.closest('.year-jump')
  if (yj) {
    const yy = Number(yj.dataset.year)
    if (yy === page.state.year.year) {
      page.yearShown = null
      buildYear()
    } else openPastYear(yy)
    return
  }

  // Clean Slate: park it, resume it, look back, navigate, answer, bulk out
  if (e.target.closest('[data-co-park]')) {
    parkCarryover()
    return
  }
  if (e.target.closest('[data-co-resume]')) {
    page.coParked = false
    renderCarryover()
    renderCarryoverNudge()
    return
  }
  if (e.target.closest('[data-co-look]')) {
    parkCarryover({ restore: false })
    openPastYear(page.state.carryover.fromYear)
    return
  }
  const goto = e.target.closest('[data-co-goto]')
  if (goto) {
    page.coIndex = Number(goto.dataset.coGoto)
    renderCarryover()
    return
  }
  if (e.target.closest('[data-co-next]')) {
    if (!coCount()) return coCommit()
    page.coIndex = 1
    renderCarryover()
    return
  }
  const bulk = e.target.closest('[data-co-all]')
  if (bulk) {
    const keep = bulk.dataset.coAll === 'yes'
    for (const it of page.state.carryover.items) if (!page.coAnswered.has(it.id)) page.coAnswered.set(it.id, keep)
    coCommit()
    return
  }
  if (e.target.closest('[data-co-yes]') || e.target.closest('[data-co-no]')) {
    coAnswer(!!e.target.closest('[data-co-yes]'), e.target.closest('.chip-btn'))
    return
  }

  // An attention row points at a card. Clicking it goes there — it used to
  // unfold chips and a text field in place, which made the strip a second
  // place to work instead of a way into the one that already exists.
  // (The tick still checks the thing off without leaving.)
  const tRow = e.target.closest('#today .today-row')
  if (tRow && !e.target.closest('.tick')) {
    const sid = tRow.closest('.today-item')?.dataset.sid
    if (sid) jumpToSpace(sid)
    return
  }

  // the day on a row is a thing you can move by hand: a calendar, not the
  // engine. The tick is left alone; only the date itself opens it.
  const when = e.target.closest('.row[data-block] .when-sub[data-when]')
  if (when && !when.closest('#today, .year-card, .demo-card, .ghost')) {
    e.preventDefault()
    e.stopPropagation()
    pickDay(when)
    return
  }

  // manual check on a list item or reminder — instant, no model.
  // One click, one request, one moment: taps on the row are ignored until
  // its card has settled, not only until the round trip returns.
  // Only the explicit checkbox completes a solo task. Its words and the
  // surrounding card open the card, so reading cannot complete it.
  const row = e.target.closest('.row[data-block], .solo[data-block]')
  if (row) {
    const checkKey=`${row.dataset.block}/${row.dataset.item || ''}`
    if(pendingChecks.has(checkKey))return
    pendingChecks.add(checkKey)
    row.dataset.busy='1'
    const done = !row.classList.contains('done')
    const clickedAt = performance.now()
    const moment = reduced || document.hidden ? STILL_MOMENT : done ? CHECK_MOMENT : UNCHECK_MOMENT
    // the same row may exist in the grid card and the focus card: keep both
    // true. Asked again each time, because a card can open during the moment.
    const item = row.dataset.item ? `[data-item="${row.dataset.item}"]` : ''
    const twinsNow = () => document.querySelectorAll(
      `.row[data-block="${row.dataset.block}"]${item}, .solo[data-block="${row.dataset.block}"]${item}`
    )
    const twins = twinsNow()
    for (const twin of twins) {
      clearInk(twin.querySelector('.row-text'))
      clearCommitTick(twin)
      twin.setAttribute('aria-busy','true')
      twin.classList.remove('no-anim')
      twin.classList.toggle('done', done)
      twin.setAttribute('aria-checked', String(done))
    }
    // The whole acknowledgment happens here, once, under the hand. The
    // response confirms it or takes it back; it never draws it a second time.
    if (done) {
      // the release answers a pointer's press; a key pressed nothing down
      if (e.detail) pop(row.querySelector('.tick') || row)
      for (const twin of twins) { commitTick(twin); drawCompletion(twin) }
    }
    // Only a row that disagrees is touched, and it changes without ceremony:
    // a card opened since the click, or a server that said otherwise.
    const repaint = (state) => {
      for (const twin of twinsNow()) {
        if (twin.classList.contains('done') === state) continue
        clearInk(twin.querySelector('.row-text'))
        clearCommitTick(twin)
        twin.classList.add('no-anim')
        twin.classList.toggle('done', state)
        twin.setAttribute('aria-checked', String(state))
      }
    }
    const unbusy = () => { for (const twin of twinsNow()) { delete twin.dataset.busy; twin.removeAttribute('aria-busy') } }

    const host = row.closest('.space, .focus-card, .today-item')
    const sid = host?.dataset.sid
    const isListItem = !!row.dataset.item
    // The card is held from here until this check lets go of it, exactly
    // once, whichever way the request ends.
    const ownerId = sid || page.state.spaces.find((s) => s.blocks?.some((b) => b.id === row.dataset.block))?.id
    holdCard(ownerId)
    let owned = true
    const letGo = (moves) => {
      if (!owned) return 'free'
      owned = false
      return leaveMoment(ownerId, checkKey, moves)
    }
    // what is confirmed right now — read when it is used, never kept
    const confirmed = () => {
      const space = page.state.spaces.find((s) => s.id === ownerId || s.blocks?.some((b) => b.id === row.dataset.block))
      const block = space?.blocks.find((b) => b.id === row.dataset.block)
      return { space, block, done: !!(isListItem ? block?.items?.find((i) => i.id === row.dataset.item)?.done : block?.done) }
    }
    // Checking a repeating reminder does not finish it — the server rolls
    // its clock to the next occurrence. The tick was left painted on, so
    // the page said "handled" and then quietly un-ticked itself later.
    const before = !isListItem && page.state.spaces.find((s) => s.id === sid)?.blocks.find((b) => b.id === row.dataset.block)
    const rolls = done && before?.type === 'reminder' && !!before.repeat && !!before.when
    // the check counts: a space with exactly one tracker ticks it live —
    // the number beats, the bar glides, and completion earns the moment
    if (isListItem && sid) {
      const sp = page.state.spaces.find((s) => s.id === sid)
      // Only animate a server-stamped relationship. Missing, withdrawn, or
      // malformed stamps stay neutral until the response is rendered.
      const listBlock = sp?.blocks.find((b) => b.id === row.dataset.block)
      const countedBy = typeof listBlock?.countedBy === 'string' ? listBlock.countedBy : ''
      const t = countedBy ? sp.blocks.find((b) => b.id === countedBy && b.type === 'tracker') : null
      if (t) {
        const prevC = t.current
        const previewCurrent=Math.max(0,prevC+(done?1:-1))
        for (const bel of document.querySelectorAll(`[data-bid="${t.id}"]`)) {
          const countEl = bel.querySelector('.tracker-count')
          const b = countEl?.querySelector('b')
          if (b) {
            b.textContent = previewCurrent
            bump(countEl)
          }
          const meterBox = bel.querySelector('.meter')
          const span = meterBox?.querySelector('span')
          if (span) span.style.width = `${Math.min(100, Math.round((previewCurrent / t.target) * 100))}%`
          meterBox?.classList.toggle('full', previewCurrent >= t.target)
          countEl?.classList.toggle('full', previewCurrent >= t.target)
        }
      }
    }

    try {
      adoptState(await api('/api/check', { blockId: row.dataset.block, itemId: row.dataset.item, done }, {signal:AbortSignal.timeout(15000)}))
      const after = confirmed().space
      const spaceId = ownerId || after?.id
      unbusy()
      // a repeating reminder keeps its tick for the moment, then comes round
      if (!rolls) repaint(confirmed().done)
      for(const tracker of after?.blocks.filter(block=>block.type==='tracker') || []) {
        for(const bel of document.querySelectorAll(`[data-bid="${tracker.id}"]`)) {
          const count=bel.querySelector('.tracker-count'),number=count?.querySelector('b')
          if(number)number.textContent=tracker.current
          const meter=bel.querySelector('.meter'),fill=meter?.querySelector('span')
          if(fill)fill.style.width=`${Math.min(100,Math.round(tracker.current/tracker.target*100))}%`
          meter?.classList.toggle('full',tracker.current>=tracker.target)
          count?.classList.toggle('full',tracker.current>=tracker.target)
        }
      }
      // adopted silently, as before: a poll inside the moment finds nothing new
      page.prev = page.state
      // The row rests for whatever is left of its moment. A slow answer has
      // already outlasted it; a fast one never cuts the brush stroke short.
      const remaining = moment - (performance.now() - clickedAt)
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
      // the ink is dry; what settles is the plain checked row
      for (const twin of twinsNow()) { clearInk(twin.querySelector('.row-text')); clearCommitTick(twin) }
      // everything below reads the latest confirmed state, not this response
      const latest = confirmed()
      if (rolls) {
        // say what actually happened: it came round again, on this date
        repaint(latest.done)
        page.prev = page.state
        // another check may still own the card; its settlement carries this row
        if (letGo(false) === 'free') {
          if (spaceId) resortCard(spaceId)
          if (page.focusId === spaceId) buildFocus()
        }
        hooks.render()
        const w = latest.block && whenPhrase(latest.block)
        toast(w ? `done · back ${w.text}` : 'done')
        return
      }
      if (latest.space?.finished) {
        letGo(false)
        await leaveArchived(latest.space.id)
        toast(`${latest.space.name} archived`)
        return
      }
      page.prev = page.state
      // The finished item rests: one real-layout move closes its old slot
      // and opens its new one, in the grid card and the opened card alike
      // (no sheen; this was your hand). A one-shot reminder leaves the
      // compact card the same way.
      letGo(true)
    } catch (err) {
      // A dropped response may still have saved. Refresh first; otherwise
      // repaint the latest confirmed snapshot, not a stale pre-click copy.
      try{adoptState(await api('/api/state',undefined,{signal:AbortSignal.timeout(5000)}))}catch{}
      const { space: affected, done: savedDone } = confirmed()
      // Nothing has moved yet, so taking the tick back moves nothing. If the
      // change did save, the card settles to it the way a confirmed check does.
      repaint(savedDone)
      if (letGo(owned && savedDone === done) === 'free') {
        if(affected)resortCard(affected.id)
        if(page.focusId && page.focusId===affected?.id)buildFocus()
      }
      delete $('#today').dataset.key
      hooks.render()
      toast(`Could not confirm the change. ${err.message}`)
    } finally {
      // a settling row keeps its key until its card is at rest
      letGo(false)
      unbusy()
    }
    return
  }

  if (e.target.closest('#undo-btn')) {
    const btn = e.target.closest('#undo-btn')
    if (btn.disabled) return
    btn.disabled = true
    try {
      adoptState(await api('/api/undo', {}))
      page.spaceEls.forEach(({ el }) => el.remove())
      page.spaceEls.clear()
      hooks.render()
      toast('undone')
    } catch (err) {
      toast(err.message)
    }
    return
  }

  if (e.target.closest('.retry')) {
    if (page.captureError) { await hooks.retryCaptureOutbox(); if (page.captureError) toast(page.captureError); return }
    try {
      await api('/api/settle', {})
      page.state.settle.lastError = null
      hooks.render()
      toast('settling')
      hooks.schedulePoll()
    } catch (err) {
      toast(err.message)
    }
    return
  }

  // anywhere quiet on a grid card: open the focused view — but selecting
  // text to copy is reading, not clicking
  const card = e.target.closest('#spaces .space')
  if (card && card.dataset.sid && !e.target.closest('button, a, summary') && !window.getSelection()?.toString()) {
    page.focusId = card.dataset.sid
    buildFocus()
  }
})

// a focused card or the dateline opens with Enter or Space
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const card = e.target.closest?.('#spaces .space')
  if (card?.dataset.sid && e.target === card) {
    e.preventDefault()
    page.focusId = card.dataset.sid
    buildFocus()
    return
  }
  if (e.target === $('#dateline')) {
    e.preventDefault()
    page.yearOpen ? closeFocus() : buildYear()
  }
})

document.addEventListener('keydown', async (e) => {
  // the receipt is gone; undo lives on the keyboard
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && (page.state?.canUndoManual || page.state?.canUndo) && !e.target.closest?.('textarea, input, [contenteditable="true"]')) {
    e.preventDefault()
    try {
      // your own last action first; the agent's batch only when you have none
      const out = await api(page.state.canUndoManual ? '/api/undo-mine' : '/api/undo', {})
      adoptState(out.state || out)
      page.spaceEls.forEach(({ el }) => el.remove())
      page.spaceEls.clear()
      hooks.render()
      toast('undone')
    } catch (err) {
      toast(err.message)
    }
    return
  }
  // Escape closes whatever is over the page — a focused card, the year, the
  // intro, the close-out question. It used to answer only to a focused card,
  // so the one dialog that asks you something was the one you could not
  // dismiss with the key everyone reaches for. Clean Slate keeps its own.
  const carryoverUp = !!(page.state?.carryover && !page.coParked && document.querySelector('.co-card'))
  if (e.key === 'Escape' && !carryoverUp && $('#focus').innerHTML && !document.querySelector('[contenteditable="true"]')) {
    closeFocus()
  }
})

// ---------------------------------------------------- fix it yourself
// Double-click any words you own and change them in place. Enter or a
// click away saves; Esc walks away.

document.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.row-text, .note-text, .space-name, .block-title, .ledger-label')
  if (!el || el.closest('.year-card, .demo-card, .ghost, #today')) return
  if (el.isContentEditable) return
  const row = el.closest('.row[data-block]')
  const card = el.closest('.space, .focus-card')
  const payload = el.classList.contains('space-name')
    ? { spaceId: card?.dataset.sid }
    : el.classList.contains('block-title')
      ? { blockId: el.closest('[data-bid]')?.dataset.bid, field: 'title' }
      : el.classList.contains('ledger-label')
        ? { blockId: el.closest('[data-bid]')?.dataset.bid, itemId: el.closest('.ledger-entry')?.dataset.item, field: 'ledger_label' }
    : el.classList.contains('note-text')
      ? { blockId: el.closest('[data-bid]')?.dataset.bid }
      : { blockId: row?.dataset.block, itemId: row?.dataset.item || undefined }
  if (!payload.spaceId && !payload.blockId) return
  const original = el.textContent
  el.contentEditable = 'true'
  el.classList.add('editing')
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)

  const finish = async (save) => {
    el.contentEditable = 'false'
    el.classList.remove('editing')
    el.removeEventListener('keydown', onKey)
    el.removeEventListener('blur', onBlur)
    const text = el.textContent.trim()
    if (!save || !text || text === original.trim()) {
      el.textContent = original
      return
    }
    try {
      adoptState(await api('/api/edit', { ...payload, text }))
      markEdited(el)
      const sid = card?.dataset.sid
      const known = sid && page.spaceEls.get(sid)
      if (known) known.updatedAt = page.state.spaces.find((s) => s.id === sid)?.updatedAt || known.updatedAt
      page.prev = page.state
    } catch (err) {
      el.textContent = original
      toast(err.message)
    }
  }
  const onKey = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      finish(true)
    }
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      finish(false)
    }
  }
  const onBlur = () => finish(true)
  el.addEventListener('keydown', onKey)
  el.addEventListener('blur', onBlur)
})

/** December's own month over the date, saved the moment a day is chosen. */
let closeDay = null
function pickDay(when) {
  const row = when.closest('.row[data-block]')
  if (!row) return
  if (closeDay) { closeDay(); closeDay = null; return }
  closeDay = openDayPicker(when, {
    value: when.dataset.when || '',
    onPick: async (text) => {
      closeDay = null
      if (text === (when.dataset.when || '')) return
      try {
        adoptState(await api('/api/edit', { blockId: row.dataset.block, field: 'when', text }))
        page.prev = page.state
        hooks.render()
      } catch (err) {
        toast(err.message)
      }
    },
  })
}

async function leaveArchived(id) {
  const leaving = page.spaceEls.get(id)?.el
  // a row still settling inside it must not travel with the card
  if (leaving) finishCardShape(leaving)
  page.spaceEls.delete(id)
  closeFocus()
  if (leaving && !reduced) {
    // Measure the cards BEFORE lifting this one out of the column. Otherwise
    // the gap has already vanished when FLIP records its starting positions.
    withFlip(() => {
      const r = leaving.getBoundingClientRect()
      Object.assign(leaving.style, {
        position: 'fixed', left: `${r.left}px`, top: `${r.top}px`,
        width: `${r.width}px`, height: `${r.height}px`, margin: '0', zIndex: '5',
      })
      leaving.inert = true
      leaving.setAttribute('aria-hidden', 'true')
      document.body.appendChild(leaving)
      void leaving.offsetHeight
      leaving.classList.add('leaving')
      hooks.render()
    })
    setTimeout(() => leaving.remove(), 460)
  } else {
    leaving?.remove()
    hooks.render()
  }
}

function jumpToSpace(sid) {
  let el = document.querySelector(`.space[data-sid="${sid}"]`)
  if (!el) {
    // a resting space wakes when something points at it
    page.awake.add(sid)
    hooks.render()
    el = document.querySelector(`.space[data-sid="${sid}"]`)
  }
  if (el) {
    // Smooth scrolling is not guaranteed to do anything. In some browsers
    // and embeddings it is simply a no-op, and then the card lights up
    // while the page never moves — the jump reads as broken. Ask for it,
    // then check, and land it plainly if nothing happened.
    const from = window.scrollY
    const want = Math.max(0, from + el.getBoundingClientRect().top - 24)
    window.scrollTo({ top: want, behavior: reduced ? 'auto' : 'smooth' })
    if (!reduced) {
      setTimeout(() => {
        if (Math.abs(window.scrollY - from) < 4 && Math.abs(want - from) > 8) {
          window.scrollTo({ top: want, behavior: 'auto' })
        }
      }, 260)
    }
    el.classList.remove('noted')
    void el.offsetWidth
    el.classList.add('noted')
    setTimeout(() => el.classList.remove('noted'), 1400)
  }
}
export { jumpToSpace }
