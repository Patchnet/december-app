import { $, page } from './session.js'
// Board mode: a coding agent's own December. The page reads the same; the
// dateline names the repo and branch, and the line speaks to the agent.
// The server sends `board` on /api/state only, so the last one seen is kept.

let board = null
export function paintBoard() {
  board = page.state?.board || board
  if (!board) return false
  const root = document.documentElement
  if (root.dataset.mode !== 'board') {
    root.dataset.mode = 'board'
    page.field.placeholder = 'Tell the agent…'
  }
  const line = [board.repo, board.branch].filter(Boolean).join(' · ')
  const el = $('#dateline')
  if (el.dataset.key !== `board|${line}`) {
    el.dataset.key = `board|${line}`
    el.textContent = line
  }
  return true
}
