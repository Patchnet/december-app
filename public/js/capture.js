import { $, toast, api, page, hooks } from './session.js'

page.field = $('#capture')
page.enterHint = $('#enter-hint')

// Lines the server has not acknowledged yet. They hooks.render immediately as
// greyed queue rows, so the beat between Enter and the response never
// shows an empty stage.

async function submitCapture() {
  const text = page.field.value.trim()
  if (!text) return
  page.queuedTexts.push(text)
  page.field.value = ''
  page.field.style.height = 'auto'
  document.documentElement.style.setProperty('--capture-h', `${page.field.offsetHeight}px`)
  page.enterHint.classList.remove('on')
  $('#shell').classList.remove('composing')
  const cw = page.field.closest('.cwrap')
  cw.classList.remove('big')
  cw.dataset.hint = ''
  localStorage.setItem('dec-files', String(Number(localStorage.getItem('dec-files') || 0) + 1))
  if ('Notification' in window && Notification.permission === 'default' && !localStorage.getItem('dec-notif-asked')) {
    localStorage.setItem('dec-notif-asked', '1')
    Notification.requestPermission().catch(() => {})
  }
  nextPrompt()
  hooks.render() // the queued line appears the same instant the field clears
  try {
    page.state = await api('/api/capture', { text })
    page.queuedTexts.splice(page.queuedTexts.indexOf(text), 1)
    hooks.render()
    hooks.schedulePoll()
  } catch (e) {
    page.queuedTexts.splice(page.queuedTexts.indexOf(text), 1)
    page.field.value = text
    $('#shell').classList.add('composing') // the draft is back; keep the page quiet
    toast(e.message)
    hooks.render()
  }
}


// The page greets you like a person, not a form — and it knows what time
// it is. Mornings ask about the day ahead; nights ask what got done.
const PROMPTS = {
  morning: ['What do you need to do today?', "What's on your mind?", "What's up?", 'Anything to remember?'],
  day: ["What's up?", "What's new?", "What's on your mind?", 'What are you tracking?', 'Anything to remember?'],
  evening: ['What did you get done?', 'What happened today?', "What's on your mind?", 'Anything to remember?'],
}
function nextPrompt() {
  const h = new Date().getHours()
  const pool = PROMPTS[h < 12 ? 'morning' : h < 17 ? 'day' : 'evening']
  let p
  do {
    p = pool[Math.floor(Math.random() * pool.length)]
  } while (p === page.field.placeholder && pool.length > 1)
  page.field.placeholder = p
}
nextPrompt()

page.field.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submitCapture()
  }
})

// answering an open ask: a time, an amount, a date, typed
document.addEventListener('keydown', async (e) => {
  const ai = e.target.closest?.('.ask-input')
  if (!ai || e.key !== 'Enter') return
  e.preventDefault()
  const choice = ai.value.trim()
  if (!choice) return
  ai.disabled = true
  try {
    page.state = await api('/api/answer', { choice, typed: true })
    hooks.render()
    hooks.schedulePoll()
  } catch (err) {
    ai.disabled = false
    toast(err.message)
  }
})

// talking to a space from inside its focus view
document.addEventListener('keydown', async (e) => {
  const fc = e.target.closest?.('.focus-capture')
  if (!fc || e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  const text = fc.value.trim()
  if (!text) return
  const hint = page.state.spaces.find((s) => s.id === page.focusId)?.name
  fc.value = ''
  try {
    page.state = await api('/api/capture', { text, hint })
    hooks.render()
    hooks.schedulePoll()
    toast(`settling into ${hint}`)
  } catch (err) {
    toast(err.message)
  }
})

// the page opens quiet; chips answer only once you reach for the field
for (const ev of ['pointerdown', 'keydown']) {
  document.addEventListener(ev, (e) => {
    if (page.reachedFor) return
    if (e.type === 'pointerdown' && !e.target.closest?.('.capture')) return
    page.reachedFor = true
    setTimeout(hooks.renderSuggestions, 0)
  })
}
page.field.addEventListener('focus', hooks.renderSuggestions)
// let a chip click land before the row goes
page.field.addEventListener('blur', () => setTimeout(hooks.renderSuggestions, 160))

const hintEligible = () => Number(localStorage.getItem('dec-files') || 0) < 5

const CAPTURE_BASE = 17 // px, the size a short line is written at
const CAPTURE_FLOOR = 14 // it never shrinks past this; past here it scrolls

/** Fit the field to what is in it: grow, then shrink the text to a floor,
    then scroll. Everything is measured at CAPTURE_BASE, never at whatever
    size is currently applied — the old code switched to a smaller font at a
    height threshold, which lowered the height, which switched it back. */
function fitCapture() {
  // it may grow into the space above the grid — which is blank while you
  // compose — but never past it, because the cards do not move
  const gridTop = document.querySelector('.body-grid')?.getBoundingClientRect().top ?? 0
  const fieldTop = page.field.getBoundingClientRect().top
  const room = Math.max(60, Math.round(gridTop - fieldTop - 28))
  const max = Math.min(room, Math.round(innerHeight * 0.4), 220)
  page.field.style.fontSize = ''
  page.field.style.height = 'auto'
  const natural = page.field.scrollHeight // always at the base size
  let size = CAPTURE_BASE
  if (natural > max) {
    // a linear guess is only an estimate — smaller text also rewraps into
    // fewer lines. Guess high, then step down to the first size that really
    // fits, so no stray scrollbar appears and then disappears again.
    size = Math.max(CAPTURE_FLOOR, Math.ceil(CAPTURE_BASE * (max / natural) * 2) / 2)
    page.field.style.fontSize = `${size}px`
    page.field.style.height = 'auto'
    while (size > CAPTURE_FLOOR && page.field.scrollHeight > max) {
      size = Math.max(CAPTURE_FLOOR, size - 0.5)
      page.field.style.fontSize = `${size}px`
      page.field.style.height = 'auto'
    }
  }
  page.field.style.fontSize = size >= CAPTURE_BASE ? '' : `${size}px`
  // The box is sized from the content measured at the BASE size, never from
  // what it looks like after shrinking. Sizing it from the shrunk text made
  // the field collapse the moment the font stepped down, then grow, then
  // collapse again — the big/small/big wobble.
  const boxH = Math.min(natural, max)
  page.field.style.height = `${boxH}px`
  page.field.style.overflowY = page.field.scrollHeight > boxH + 1 ? 'auto' : 'hidden'
  document.documentElement.style.setProperty('--capture-h', `${page.field.offsetHeight}px`)
  return natural
}

page.field.addEventListener('input', () => {
  const natural = fitCapture()
  page.enterHint.classList.toggle('on', !!page.field.value.trim() && hintEligible())
  $('#shell').classList.toggle('composing', !!page.field.value.trim())
  hooks.renderStage()
  hooks.renderSuggestions()
  // a dump is an object, not a floating wall: contain it past two lines
  // on a phone the field is fixed to the bottom edge: the page must always
  // be able to scroll clear of whatever height it grows to
  const cwrap = page.field.closest('.cwrap')
  // hysteresis: it becomes a block at 72 and stops being one at 52, so a
  // single character near the boundary cannot toggle the treatment
  const big = cwrap.classList.contains('big') ? natural > 52 : natural > 72
  cwrap.classList.toggle('big', big)
  // Every line files separately, so say so the moment there IS a second
  // line. Tying the notice to the block treatment meant a two-line thought
  // — the most ordinary case there is — was split in two with no warning.
  const n = page.field.value.split('\n').filter((l) => l.trim()).length
  cwrap.dataset.hint = n > 1 ? `${n} lines · enter files each one` : ''
})

// The page is the input: start typing anywhere and it lands in the capture.
// Space alone still scrolls; with the focus view open, typing lands there.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const tag = document.activeElement?.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT') return
  if (e.key.length !== 1) return
  if (e.key === ' ') return
  if (e.key === '/') {
    e.preventDefault()
    $('#search').focus()
    return
  }
  const target = page.focusId ? document.querySelector('.focus-capture') : page.field
  target?.focus()
})

// --------------------------------------------------------- drag and drop
// A dropped document becomes a capture pointing at the saved file; the
// settle agent reads it like anything else you wrote.

const dropzone = $('#dropzone')
let dragDepth = 0

document.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return
  e.preventDefault()
  dragDepth++
  dropzone.hidden = false
})
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('dragleave', (e) => {
  e.preventDefault()
  if (--dragDepth <= 0) {
    dragDepth = 0
    dropzone.hidden = true
  }
})
document.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  dropzone.hidden = true
  const files = [...e.dataTransfer.files].slice(0, 5)
  for (const file of files) {
    try {
      const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'upload failed')
      page.state = data
      hooks.render()
      toast(`reading ${file.name}`)
    } catch (err) {
      toast(err.message)
    }
  }
})
export { fitCapture, submitCapture }
