import { $, toast, api, page, hooks, reduced } from './session.js'
import { whenPhrase } from './blocks.js'
import { celebrate, pop, washCard, withFlip, celebrateSpace, markEdited, bump } from './motion.js'
import { buildFocus, closeFocus, askToFinish, resortCard } from './layout.js'
import { openPastYear, buildYear, openMonth, renderCarryover, renderCarryoverNudge, coAnswer, coCommit, coCount } from './year.js'

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
      page.state = out.state
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
      page.state = out.state
      withFlip(() => hooks.render())
      if (page.focusId) buildFocus()
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
      page.state = out.state
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
      page.state = out.state
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
      page.state = out.state
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
    const text = sug.dataset.suggest
    setTimeout(async () => {
      try {
        page.state = await api('/api/capture', { text })
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

  // answering the ask: the chosen sentence files as if typed
  const ans = e.target.closest('[data-answer]')
  if (ans) {
    ans.classList.add('picked')
    setTimeout(async () => {
      try {
        page.state = await api('/api/answer', { choice: ans.dataset.answer })
        hooks.render()
        hooks.schedulePoll()
      } catch (err) {
        toast(err.message)
      }
    }, 240)
    return
  }
  if (e.target.closest('[data-dismiss]')) {
    try {
      page.state = await api('/api/answer', {})
      hooks.render()
    } catch (err) {
      toast(err.message)
    }
    return
  }

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
    page.yearShown = null
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
    page.coParked = true
    renderCarryover()
    renderCarryoverNudge()
    return
  }
  if (e.target.closest('[data-co-resume]')) {
    page.coParked = false
    renderCarryover()
    renderCarryoverNudge()
    return
  }
  if (e.target.closest('[data-co-look]')) {
    page.coParked = true
    renderCarryover()
    renderCarryoverNudge()
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

  // manual check on a list item or reminder — instant, no model.
  // One click, one request: taps during the round trip are ignored.
  // A solo card IS its reminder: the whole card is the checkbox, markup and
  // aria and all. It was left out of this selector, so the most common card
  // on the page could not be ticked off by clicking it — and because it is a
  // button, the open-the-card handler below skipped it too. It did nothing.
  const row = e.target.closest('.row[data-block], .solo[data-block]')
  if (row) {
    if (row.dataset.busy) return
    row.dataset.busy = '1'
    setTimeout(() => delete row.dataset.busy, 600)
    const done = !row.classList.contains('done')
    // the same row may exist in the grid card and the focus card: keep both true
    const item = row.dataset.item ? `[data-item="${row.dataset.item}"]` : ''
    const twins = document.querySelectorAll(
      `.row[data-block="${row.dataset.block}"]${item}, .solo[data-block="${row.dataset.block}"]${item}`
    )
    for (const twin of twins) {
      twin.classList.remove('no-anim')
      twin.classList.toggle('done', done)
      twin.setAttribute('aria-checked', String(done))
    }
    if (done) {
      // a solo card has no tick of its own; the card is the mark
      const mark = row.querySelector('.tick') || row
      pop(mark)
      celebrate(mark)
      // finishing the whole list earns the card a wash
      const blockEl = row.closest('[data-bid]')
      if (blockEl && ![...blockEl.querySelectorAll('.row')].some((r) => !r.classList.contains('done'))) {
        setTimeout(() => washCard(row.closest('.space')), 300)
      }
    }

    // the check counts: a space with exactly one tracker ticks it live —
    // the number beats, the bar glides, and completion earns the moment
    const host = row.closest('.space, .focus-card, .today-item')
    const sid = host?.dataset.sid
    const isListItem = !!row.dataset.item
    // Checking a repeating reminder does not finish it — the server rolls
    // its clock to the next occurrence. The tick was left painted on, so
    // the page said "handled" and then quietly un-ticked itself later.
    const before = !isListItem && page.state.spaces.find((s) => s.id === sid)?.blocks.find((b) => b.id === row.dataset.block)
    const rolls = done && before?.type === 'reminder' && !!before.repeat && !!before.when
    if (isListItem && sid) {
      const sp = page.state.spaces.find((s) => s.id === sid)
      // Only animate a server-stamped relationship. Missing, withdrawn, or
      // malformed stamps stay neutral until the response is rendered.
      const listBlock = sp?.blocks.find((b) => b.id === row.dataset.block)
      const countedBy = typeof listBlock?.countedBy === 'string' ? listBlock.countedBy : ''
      const t = countedBy ? sp.blocks.find((b) => b.id === countedBy && b.type === 'tracker') : null
      if (t) {
        const prevC = t.current
        t.current = Math.max(0, prevC + (done ? 1 : -1))
        const completedNow = done && prevC < t.target && t.current >= t.target
        for (const bel of document.querySelectorAll(`[data-bid="${t.id}"]`)) {
          const countEl = bel.querySelector('.tracker-count')
          const b = countEl?.querySelector('b')
          if (b) {
            b.textContent = t.current
            bump(countEl)
          }
          const meterBox = bel.querySelector('.meter')
          const span = meterBox?.querySelector('span')
          if (span) span.style.width = `${Math.min(100, Math.round((t.current / t.target) * 100))}%`
          meterBox?.classList.toggle('full', t.current >= t.target)
          countEl?.classList.toggle('full', t.current >= t.target)
          if (completedNow) {
            pop(meterBox)
            celebrate(meterBox)
          }
        }
        if (completedNow) setTimeout(() => washCard(page.spaceEls.get(sid)?.el), 250)
      }
    }

    try {
      page.state = await api('/api/check', { blockId: row.dataset.block, itemId: row.dataset.item, done })
      const after = page.state.spaces.find((s) => s.id === sid || s.blocks?.some((b) => b.id === row.dataset.block))
      const spaceId = sid || after?.id
      const known = spaceId && page.spaceEls.get(spaceId)
      if (rolls) {
        // say what actually happened: it came round again, on this date
        const now = after?.blocks.find((b) => b.id === row.dataset.block)
        page.prev = page.state
        if (spaceId) resortCard(spaceId)
        if (page.focusId === spaceId) buildFocus()
        hooks.render()
        const w = now && whenPhrase(now)
        toast(w ? `done · back ${w.text}` : 'done')
        return
      }
      // adopt silently; the row is already painted
      if (after?.finished) {
        await leaveArchived(after.id)
        toast(`${after.name} archived`)
        return
      }
      if (known) known.updatedAt = after?.updatedAt
      page.prev = page.state
      // after the moment, the finished item rests: the card re-sorts it
      // into the done tail with a glide (no sheen; this was your hand).
      // A one-shot reminder leaves the compact card the same way — left
      // "adopted silently" it stayed painted, checked, until something
      // else happened to re-render the card.
      if ((isListItem || before?.type === 'reminder') && spaceId) {
        setTimeout(() => {
          resortCard(spaceId)
          if (page.focusId === spaceId) buildFocus()
        }, done ? 900 : 400)
      }
    } catch (err) {
      toast(err.message)
    }
    return
  }

  if (e.target.closest('#undo-btn')) {
    const btn = e.target.closest('#undo-btn')
    if (btn.disabled) return
    btn.disabled = true
    try {
      page.state = await api('/api/undo', {})
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
  if (card && card.dataset.sid && !e.target.closest('button, a') && !window.getSelection()?.toString()) {
    page.focusId = card.dataset.sid
    buildFocus()
  }
})

// a focused card or the dateline opens with Enter or Space
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const card = e.target.closest?.('#spaces .space')
  if (card?.dataset.sid) {
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
      page.state = out.state || out
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
  // the ceremony answers to the keyboard, and never traps you
  if (page.state?.carryover && !page.coParked && document.querySelector('.co-card')) {
    if (e.key === 'Escape') {
      page.coParked = true
      renderCarryover()
      renderCarryoverNudge()
    }
    if (page.coIndex > 0 && (e.key === 'y' || e.key === 'n')) {
      coAnswer(e.key === 'y', document.querySelector(e.key === 'y' ? '[data-co-yes]' : '[data-co-no]'))
    }
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
      page.state = await api('/api/edit', { ...payload, text })
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

async function leaveArchived(id) {
  const leaving = page.spaceEls.get(id)?.el
  page.spaceEls.delete(id)
  closeFocus()
  if (leaving && !reduced) {
    const r = leaving.getBoundingClientRect()
    Object.assign(leaving.style, {
      position: 'fixed',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      margin: '0',
      zIndex: '5',
    })
    document.body.appendChild(leaving)
    void leaving.offsetHeight
    leaving.classList.add('leaving')
    withFlip(() => hooks.render())
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
