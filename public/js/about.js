import { $, toast, api, page, hooks } from './session.js'
import { openSettings, closeSettings } from './connections.js'

const letter = $('#letter-toggle')
const menu = $('#letter-menu')
const aboutPop = $('#about-pop')
const aboutField = $('#about-md')
const backdrop = $('#settings-backdrop')

function aboutState() {
  return page.state?.about || { markdown: '', name: '', initial: 'D', updatedAt: null }
}

export function paintLetter() {
  if (!letter) return
  const initial = aboutState().initial || 'D'
  if (letter.textContent !== initial) letter.textContent = initial
}

function menuOpen() {
  return menu && !menu.hidden
}

function closeMenu() {
  if (!menu || menu.hidden) return
  menu.hidden = true
  letter?.setAttribute('aria-expanded', 'false')
}

function openMenu() {
  if (!menu) return
  menu.hidden = false
  letter?.setAttribute('aria-expanded', 'true')
  $('#open-about')?.focus()
}

function aboutFocusables() {
  return [...aboutPop.querySelectorAll('button:not(:disabled), textarea:not(:disabled)')]
}

async function saveAbout() {
  const markdown = aboutField.value
  if (markdown === (aboutState().markdown || '')) return aboutState()
  try {
    page.state = await api('/api/about', { markdown, mode: 'set' })
    paintLetter()
    hooks.render()
    toast('About Me saved')
    return page.state.about
  } catch (error) {
    toast(error.message)
    throw error
  }
}

function closeAbout(restoreFocus = true) {
  if (aboutPop.hidden) return
  aboutPop.hidden = true
  if ($('#settings-pop').hidden) {
    backdrop.hidden = true
    document.documentElement.classList.remove('modal-open')
  }
  if (restoreFocus) letter?.focus()
}

async function openAbout() {
  closeMenu()
  closeSettings(false)
  backdrop.hidden = false
  aboutPop.hidden = false
  document.documentElement.classList.add('modal-open')
  aboutField.value = aboutState().markdown || ''
  aboutField.focus()
}

letter?.addEventListener('click', (event) => {
  event.stopPropagation()
  if (menuOpen()) closeMenu()
  else openMenu()
})

$('#open-about')?.addEventListener('click', () => openAbout())
$('#open-settings')?.addEventListener('click', () => {
  closeMenu()
  closeAbout(false)
  openSettings()
})
$('#about-save')?.addEventListener('click', () => saveAbout())
$('#about-close')?.addEventListener('click', async () => {
  try {
    await saveAbout()
  } catch {
    return
  }
  closeAbout()
})

document.addEventListener('mousedown', (event) => {
  if (menuOpen() && !event.target.closest('.letter-wrap')) closeMenu()
  if (!aboutPop.hidden && event.target === backdrop) {
    saveAbout().then(() => closeAbout()).catch(() => {})
  }
})

document.addEventListener('keydown', (event) => {
  if (menuOpen() && event.key === 'Escape') {
    closeMenu()
    letter?.focus()
    return
  }
  if (aboutPop.hidden) return
  if (event.key === 'Escape') {
    saveAbout().then(() => closeAbout()).catch(() => {})
    return
  }
  if (event.key === 's' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    saveAbout()
    return
  }
  if (event.key !== 'Tab') return
  const items = aboutFocusables()
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
})
