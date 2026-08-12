#!/usr/bin/env node
// December connection doctor and wizard. It shares all filesystem and
// registration behavior with the in-app Connections panel.

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { CLIENTS, publishSkills, register, statuses } from './lib/connect.mjs'

function parseArgs(argv) {
  const parsed = { yes: false, options: {}, clients: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') parsed.yes = true
    else if (arg === '--home') parsed.options.home = argv[++i]
    else if (arg === '--app-data') parsed.options.appData = argv[++i]
    else if (arg === '--root') parsed.options.root = argv[++i]
    else if (arg === '--url') parsed.options.url = argv[++i]
    else if (arg === '--clients') parsed.clients = String(argv[++i] || '').split(',').filter(Boolean)
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return parsed
}

const statusText = (status) => {
  if (status.state === 'connected') return 'connected'
  if (status.state === 'available') return 'available'
  if (status.state === 'not-installed') return 'not installed'
  return `error: ${status.detail || 'unknown error'}`
}

function printBoard(board, write = output) {
  write.write('\nClient            Status\n')
  write.write('----------------  ----------------------------------------\n')
  for (const client of CLIENTS) {
    const status = board[client]
    write.write(`${String(status?.label || client).padEnd(18)}${statusText(status || { state: 'error' })}\n`)
  }
}

async function wantsConnection(status, yes, rl) {
  if (!status.installed) return false
  if (yes) return true
  const verb = status.state === 'connected' ? 'Reconnect' : 'Connect'
  const answer = await rl.question(`${verb} ${status.label}? [y/N] `)
  return /^y(?:es)?$/i.test(answer.trim())
}

export async function runWizard({ argv = process.argv.slice(2), write = output, options = {} } = {}) {
  const args = parseArgs(argv)
  args.options = { ...options, ...args.options }
  if (args.help) {
    write.write('Usage: node connect.mjs [--yes] [--home PATH] [--app-data PATH] [--url URL]\n')
    return 0
  }

  write.write('December connection doctor\n')
  let board = await statuses(args.options)
  printBoard(board, write)
  const selected = args.clients || CLIENTS
  const rl = args.yes ? null : createInterface({ input, output })
  const failures = []
  let changed = 0
  try {
    for (const client of selected) {
      if (!CLIENTS.includes(client)) {
        failures.push(`${client}: unknown client`)
        continue
      }
      if (!await wantsConnection(board[client], args.yes, rl)) continue
      write.write(`\nConnecting ${board[client].label}… `)
      try {
        await register(client, args.options)
        changed++
        write.write('done\n')
      } catch (error) {
        failures.push(`${board[client].label}: ${error.message}`)
        write.write('failed\n')
      }
    }
  } finally {
    rl?.close()
  }

  try {
    const skills = await publishSkills(args.options)
    const published = Object.values(skills).filter((item) => item.status === 'published').length
    write.write(`\nDecember skill ready in Claude, Codex, and Cursor${published ? ` (${published} updated)` : ''}.\n`)
  } catch (error) {
    failures.push(`December skill: ${error.message}`)
  }

  board = await statuses(args.options)
  printBoard(board, write)
  if (!changed && !Object.values(board).some((status) => status.installed)) {
    write.write('\nNo supported local clients were detected. Install one, then run this wizard again.\n')
  }
  if (failures.length) {
    write.write(`\nNeeds attention:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`)
    return 1
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runWizard().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
