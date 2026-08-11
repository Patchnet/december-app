// The December tool surface — pure data + dispatch. Used by the web
// server (POST /api/tool) and advertised verbatim by the MCP adapter, so
// every assistant sees exactly one interface.

import * as core from './core.mjs'
import { BLOCK_TYPES, createBlockFields, typeDocs } from './blocks.mjs'

export const TOOLS = [
  {
    name: 'december_view',
    description:
      'Read the whole December page: every space with its blocks (all ids included), the unfiled inbox captures, and the lessons the person has taught the engine. Call this first, always, before writing anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'december_capture',
    description:
      'Drop raw text onto the December page as a new inbox capture, exactly as a person typing on the page would. Use when the user wants to add something to December without organizing it themselves.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The raw text, verbatim.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_create_space',
    description: 'Create a space (a named area of the page, e.g. "Housing expenses"). Returns its id. If a space with that name exists, returns the existing one.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Short human name, sentence case.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_create_block',
    description: `Add a block to a space. Exactly six types exist: ${typeDocs()}. Provide only the fields for the chosen type.`,
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space id or name; created if the name is new.' },
        type: { type: 'string', enum: BLOCK_TYPES },
        title: { type: 'string' },
        ...createBlockFields(),
      },
      required: ['space', 'type', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_update_block',
    description:
      'Update one block by id. list: add_items / check_item_ids / uncheck_item_ids. tracker: set_current, delta, set_target. ledger: entry_label + entry_amount appends one entry. streak: mark_date (defaults today). note: note_text with note_mode set|append. reminder: reminder_done. Any block: retitle.',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string' },
        add_items: { type: 'array', items: { type: 'string' } },
        check_item_ids: { type: 'array', items: { type: 'string' } },
        uncheck_item_ids: { type: 'array', items: { type: 'string' } },
        set_current: { type: 'number' },
        delta: { type: 'number' },
        set_target: { type: 'number' },
        entry_label: { type: 'string' },
        entry_amount: { type: 'number' },
        mark_date: { type: 'string' },
        note_text: { type: 'string' },
        note_mode: { type: 'string', enum: ['set', 'append'] },
        reminder_done: { type: 'boolean' },
        retitle: { type: 'string' },
      },
      required: ['blockId'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_file_capture',
    description:
      'Mark an inbox capture as filed into a space, with a one-line plain-words summary of what was done with it ("logged August rent, 8 of 12"). Every organizing pass must end with the whole inbox filed — a capture left unfiled stays visibly unsettled on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        captureId: { type: 'string' },
        space: { type: 'string', description: 'Space id or name.' },
        summary: { type: 'string' },
      },
      required: ['captureId', 'space', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_learn',
    description:
      'Record a durable lesson about how this person wants things organized ("groceries go under Food, not Housing"). Lessons are shown to every future organizing pass and must be obeyed.',
    inputSchema: {
      type: 'object',
      properties: { lesson: { type: 'string' } },
      required: ['lesson'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_suggest',
    description:
      'Set up to three suggestion chips shown under the input: short, complete sentences in the person\'s own words that they might naturally say next ("mark today\'s run"). Tapping one files it exactly as if typed. Refresh them each organizing pass; pass an empty array to clear. Never invent topics their content does not contain.',
    inputSchema: {
      type: 'object',
      properties: { suggestions: { type: 'array', items: { type: 'string' }, maxItems: 3 } },
      required: ['suggestions'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_ask',
    description:
      'Pose ONE quiet question when a capture is genuinely ambiguous between concrete options. Each option must be a complete standalone statement that fully resolves the question ("Groceries go under Food"), because tapping it files as if the person typed it. One slot: a new ask replaces the old. File your best guess anyway — never leave a capture unfiled waiting on an answer.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_undo',
    description: 'Revert the page to its snapshot from just before the most recent agent write batch. One level only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

/** Dispatch a tool call against the core. settleStatus feeds december_view. */
export async function callTool(name, args = {}, settleStatus = {}) {
  switch (name) {
    case 'december_view':
      return core.project(settleStatus)
    case 'december_capture':
      return core.addCapture(args.text)
    case 'december_create_space':
      return core.createSpace(args.name)
    case 'december_create_block': {
      const { space, ...spec } = args
      return core.createBlock(space, spec)
    }
    case 'december_update_block': {
      const { blockId, ...patch } = args
      return core.updateBlock(blockId, patch)
    }
    case 'december_file_capture':
      return core.fileCapture(args.captureId, args.space, args.summary)
    case 'december_learn':
      return core.addLesson(args.lesson)
    case 'december_suggest':
      return core.setSuggestions(args.suggestions)
    case 'december_ask':
      return core.setAsk(args.question, args.options)
    case 'december_undo':
      await core.undo()
      return { ok: true }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
