import { $, esc, api, page, hooks } from './session.js'

// a question ends in '?' or opens like one: answered, never filed
const QUESTION_RE = /^(how|what|when|where|which|who|why|do i|did i|am i|is there|are there|can i|have i|show me|list )\b/i
const looksLikeQuestion = (t) => t.endsWith('?') || QUESTION_RE.test(t.trim())

/** Questions belong with finding, not with writing: the answer appears in
    the search results, and leaves when the search does. */
async function askThePage(question) {
  const box = $('#search-results')
  box.classList.add('on')
  box.innerHTML = `<div class="search-answer thinking">thinking<span class="a-dots"><i>.</i><i>.</i><i>.</i></span></div>`
  try {
    const { answer } = await api('/api/query', { question })
    box.innerHTML = `<div class="search-answer">${esc(answer)}</div>`
  } catch (err) {
    box.innerHTML = `<div class="search-answer">couldn't answer: ${esc(err.message)}</div>`
  }
}

// ------------------------------------------------------------- the search
// One quiet field in the header: a few letters, everything answers.

const searchEl = $('#search')
const resultsEl = $('#search-results')

function searchEverything(q) {
  q = q.toLowerCase()
  const out = []
  const add = (label, space, sid) => {
    if (out.length < 8 && label.toLowerCase().includes(q)) out.push({ label, space, sid })
  }
  for (const s of page.state.spaces) {
    add(s.name, '', s.id)
    for (const b of s.blocks) {
      if (b.title) add(b.title, s.name, s.id)
      if (b.type === 'list') for (const i of b.items) add(i.text, s.name, s.id)
      if (b.type === 'reminder') add(b.text, s.name, s.id)
      if (b.type === 'note') {
        const at = b.text.toLowerCase().indexOf(q)
        if (at >= 0 && out.length < 8) out.push({ label: `…${b.text.slice(Math.max(0, at - 12), at + 28)}…`, space: s.name, sid: s.id })
      }
      if (b.type === 'ledger') for (const en of b.entries) add(en.label, s.name, s.id)
    }
  }
  return out
}

function closeSearch() {
  resultsEl.innerHTML = ''
  resultsEl.classList.remove('on')
}

searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim()
  if (q.length < 2) return closeSearch()
  if (resultsEl.querySelector('.search-answer')) resultsEl.innerHTML = ''
  const hits = searchEverything(q)
  resultsEl.innerHTML = hits.length
    ? hits
        .map((h, i) => `<button class="search-hit" data-hit="${h.sid}" style="--d:${Math.min(i * 28, 140)}ms"><span class="sh-label">${esc(h.label.slice(0, 44))}</span>${h.space ? `<span class="sh-space">${esc(h.space)}</span>` : ''}</button>`)
        .join('')
    : '<div class="search-none">nothing found</div>'
  resultsEl.classList.add('on')
})

searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchEl.value = ''
    closeSearch()
    searchEl.blur()
  }
  if (e.key === 'Enter') {
    const q = searchEl.value.trim()
    // a question is asked; a word is looked up
    if (looksLikeQuestion(q) && q.length > 6) {
      askThePage(q)
      searchEl.value = ''
      return
    }
    const first = resultsEl.querySelector('.search-hit')
    if (first) {
      hooks.jumpToSpace(first.dataset.hit)
      searchEl.value = ''
      closeSearch()
      searchEl.blur()
    }
  }
})

document.addEventListener('click', (e) => {
  const hit = e.target.closest('.search-hit')
  if (hit) {
    hooks.jumpToSpace(hit.dataset.hit)
    searchEl.value = ''
    closeSearch()
    return
  }
  if (!e.target.closest('.search-wrap')) closeSearch()
})
