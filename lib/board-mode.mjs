// Board mode — the mode is never chosen by hand. When December's MCP
// connection starts inside a git work tree (a coding session), that repo
// gets its own board: a December store the agent keeps and the person
// watches. Anywhere else the connection gets the person's own page.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const git = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
  } catch {
    return ''
  }
}

/** The branch a work tree is on; a fresh repo with no commits still has one. */
export function currentBranch(root) {
  const name = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || git(root, ['symbolic-ref', '--short', 'HEAD'])
  if (name !== 'HEAD') return name
  const sha = git(root, ['rev-parse', '--short', 'HEAD'])
  return sha ? `detached ${sha}` : ''
}

/** A board's folder name: the repo's name plus a short hash of where it lives,
    so two checkouts of the same repo never share a board. */
export function boardSlug(root) {
  const name = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'repo'
  return `${name}-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 8)}`
}

/**
 * Which December this connection gets. clientName (claude-code,
 * codex-mcp-client …) is kept as a hint and decides nothing. DECEMBER_MODE
 * overrides. December's own organizer and read passes always work on the page.
 */
export function detectMode({ cwd = process.cwd(), clientName = '', env = process.env } = {}) {
  const forced = String(env.DECEMBER_MODE || '').trim().toLowerCase()
  const client = String(clientName || '')
  const page = { mode: 'page', client }
  if (forced === 'page') return page
  if (forced !== 'board' && ['organizer', 'read'].includes(env.DECEMBER_ACCESS)) return page
  let root = git(cwd, ['rev-parse', '--show-toplevel'])
  // a home folder kept under git is not a coding session
  if (forced !== 'board' && (!root || resolve(root) === resolve(homedir()))) return page
  root = resolve(root || cwd)
  return { mode: 'board', root, repo: basename(root), branch: currentBranch(root), slug: boardSlug(root), client }
}

/** Where boards live: beside the December data folder, …/December/boards. */
export function boardsDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.DECEMBER_BOARDS_DIR) return resolve(env.DECEMBER_BOARDS_DIR)
  if (env.DECEMBER_DATA_DIR) return join(dirname(resolve(env.DECEMBER_DATA_DIR)), 'boards')
  const appData = platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || join(home, '.config')
  return join(appData, 'December', 'boards')
}

/** The board a server was started for, or null on the person's page. */
export function boardFromEnv(env = process.env) {
  if (env.DECEMBER_MODE !== 'board') return null
  return { repo: env.DECEMBER_BOARD_REPO || '', branch: env.DECEMBER_BOARD_BRANCH || '', root: env.DECEMBER_BOARD_ROOT || '' }
}

// What a connected agent is held to on its own board. Short on purpose: the
// tools carry their own guidance.
export const BOARD_MANNERS = `# December board

You own this board. The person watches it to see the plan and the work, and steers from it.

- One card per workstream: \`december_create_space\`, then a list block (\`december_create_block\`, type list) for its tasks.
- Rows are tasks named as names, not sentences: "Read the git root", "Write the hook install line".
- Mark a task done (\`december_add_or_check\`) only with proof: the test count, the commit or the file, in a note (\`december_write_note\`) or in the row.
- Ask with \`december_ask\` before a push, a merge or any destructive step, and wait for the answer. Short options: Push / Not yet.
- Read the person's notes each turn: they are the inbox captures in \`december_view\`. Act on each one, then file it with \`december_file_capture\`.
- \`december_capture\` is the person's line. Don't write to it.`
