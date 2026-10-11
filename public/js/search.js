import {createSearchIndex, searchIndex} from './search-index.js'
import { $, esc, api, page, hooks } from './session.js'

// a question ends in '?' or opens like one: answered, never filed
const QUESTION_RE = /^(how|what|when|where|which|who|why|do i|did i|am i|is there|are there|can i|have i|show me|list )\b/i
const looksLikeQuestion = (t) => t.endsWith('?') || QUESTION_RE.test(t.trim())

/** Questions belong with finding, not with writing: the answer appears in
    the search results, and leaves when the search does. */
let searchRevision = 0
let lastQuestion = ''
let questionController=null
const cancelQuestion=()=>{questionController?.abort();questionController=null}
async function askThePage(question) {
  cancelQuestion()
  questionController=new AbortController()
  const signal=questionController.signal
  lastQuestion = question
  const revision = ++searchRevision
  const box = $('#search-results')
  showResults(false)
  active = -1
  searchEl.removeAttribute('aria-activedescendant')
  box.innerHTML = `<div class="search-asked waiting" role="status">${esc(question)}</div>`
  try {
    const { answer } = await api('/api/query', { question },{signal})
    if (revision !== searchRevision) return
    box.innerHTML = `<div class="search-asked">${esc(question)}</div><div class="search-answer" role="status">${esc(answer)}</div>`
  } catch (err) {
    if (revision !== searchRevision) return
    box.innerHTML = `<div class="search-asked">${esc(question)}</div><div class="search-answer" role="status">Couldn’t answer. ${esc(err.message)}</div><button class="search-retry" type="button">Try again</button>`
  }
}

// ------------------------------------------------------------- the search
// One quiet field in the header: a few letters, everything answers.

const searchEl = $('#search')
const resultsEl = $('#search-results')
let active = -1
searchEl.setAttribute('role', 'combobox')
searchEl.setAttribute('aria-autocomplete', 'list')
searchEl.setAttribute('aria-controls', 'search-results')
searchEl.setAttribute('aria-expanded', 'false')
function showResults(list = true) {
  resultsEl.classList.add('on')
  resultsEl.setAttribute('role', list ? 'listbox' : 'region')
  resultsEl.setAttribute('aria-label', list ? 'Matching spaces and notes' : 'Answer')
  searchEl.setAttribute('aria-expanded', 'true')
}
function setActive(index) {
  const hits = [...resultsEl.querySelectorAll('.search-hit')]
  active = Math.max(-1, Math.min(index, hits.length - 1))
  hits.forEach((el, i) => {
    el.classList.toggle('active', i === active)
    el.setAttribute('aria-selected', String(i === active))
  })
  if (hits[active]) {
    searchEl.setAttribute('aria-activedescendant', hits[active].id)
    hits[active].scrollIntoView({block: 'nearest'})
  } else searchEl.removeAttribute('aria-activedescendant')
}
function matchInk(label, q) {
  const at = label.toLowerCase().indexOf(q.toLowerCase())
  return at < 0 ? esc(label) : `${esc(label.slice(0, at))}<mark>${esc(label.slice(at, at + q.length))}</mark>${esc(label.slice(at + q.length))}`
}

let indexedRevision=null,indexedSpaces=null,index=[]
function searchEverything(q) {
  if(indexedSpaces!==page.state.spaces || indexedRevision!==page.state.revision) {
    index=createSearchIndex(page.state.spaces)
    indexedSpaces=page.state.spaces;indexedRevision=page.state.revision
  }
  return searchIndex(index,q,{spaceId:page.focusId})
}

function closeSearch() {
  cancelQuestion()
  searchRevision++
  resultsEl.innerHTML = ''
  resultsEl.classList.remove('on')
  active = -1
  searchEl.setAttribute('aria-expanded', 'false')
  searchEl.removeAttribute('aria-activedescendant')
}

searchEl.addEventListener('input', () => {
  cancelQuestion()
  searchRevision++
  const q = searchEl.value.trim()
  if (q.length < 2) return closeSearch()
  if (resultsEl.querySelector('.search-answer')) resultsEl.innerHTML = ''
  const hits = searchEverything(q)
  resultsEl.innerHTML = hits.length
    ? hits
        .map((h, i) => `<button type="button" role="option" aria-selected="false" tabindex="-1" id="search-hit-${i}" class="search-hit${h.space ? '' : ' is-card'}" data-hit="${esc(h.sid)}"><span class="sh-label">${matchInk(h.label, q)}</span>${h.space ? `<span class="sh-space">${esc(h.space)}</span>` : ''}</button>`)
        .join('')
    : '<div class="search-none" role="status">No matches. Try a different word.</div>'
  if (looksLikeQuestion(q) && q.length > 6) resultsEl.insertAdjacentHTML('beforeend', '<div class="search-foot">Press Return to ask</div>')
  showResults()
  setActive(-1)
})

searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    setActive(active + (e.key === 'ArrowDown' ? 1 : -1))
    return
  }
  if (e.key === 'Escape') {
    searchEl.value = ''
    closeSearch()
    searchEl.blur()
  }
  if (e.key === 'Enter') {
    const q = searchEl.value.trim()
    // a question is asked; a word is looked up
    if (active < 0 && looksLikeQuestion(q) && q.length > 6) {
      askThePage(q)
      return
    }
    const hit = resultsEl.querySelectorAll('.search-hit')[Math.max(0, active)]
    if (hit) {
      hooks.jumpToSpace(hit.dataset.hit)
      searchEl.value = ''
      closeSearch()
      searchEl.blur()
    }
  }
})

document.addEventListener('click', (e) => {
  if (e.target.closest('.search-retry')) { askThePage(lastQuestion); return }
  const hit = e.target.closest('.search-hit')
  if (hit) {
    hooks.jumpToSpace(hit.dataset.hit)
    searchEl.value = ''
    closeSearch()
    return
  }
  if (!e.target.closest('.search-wrap')) closeSearch()
})

resultsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); searchEl.focus() }
})

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !document.documentElement.classList.contains('modal-open') && !document.querySelector('dialog[open]')) {
    e.preventDefault()
    searchEl.focus()
    searchEl.select()
  }
})
