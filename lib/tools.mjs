// The December tool surface — pure data + dispatch. Used by the web
// server (POST /api/tool) and advertised verbatim by the MCP adapter, so
// every assistant sees exactly one interface.

import * as core from './core.mjs'
import { BLOCK_TYPES, createBlockFields, entitiesField, typeDocs, verbTools, verbPatch } from './blocks.mjs'

export const TOOLS = [
  {
    name: 'december_view',
    description:
      'Read the whole December page: About Me, every space with its blocks (all ids included), the unfiled inbox captures, and the lessons the person has taught the engine. Call this first, always, before writing anything. Read About Me before filing standing facts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'december_read_block',
    description:
      'Read one block by id, complete and untruncated: every list item, every ledger entry, every streak date, the full note text. Use when the condensed view marks something elided (moreEntries, moreDone, textTruncated) and a capture depends on it.',
    inputSchema: {
      type: 'object',
      properties: { blockId: { type: 'string' } },
      required: ['blockId'],
      additionalProperties: false,
    },
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
        entities: entitiesField,
        source: { type: 'string', description: 'The captureId this block comes from, so changes stay traceable.' },
        ...createBlockFields(),
      },
      required: ['space', 'type', 'title'],
      additionalProperties: false,
    },
  },
  ...verbTools(),
  {
    name: 'december_retitle',
    description: 'Change the title of one block. For a space name or an item wording, use december_rename instead.',
    inputSchema: {
      type: 'object',
      properties: { blockId: { type: 'string' }, title: { type: 'string' } },
      required: ['blockId', 'title'],
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
    name: 'december_write_about',
    description:
      'Write the reserved About Me profile (who they are: family, likes, schools, birthdays, addresses). Use append when they state a standing fact. Use set only when they ask to replace the whole profile. Never invent. Never overwrite the whole profile on append. Lessons stay in december_learn.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Markdown to set or append.' },
        mode: { type: 'string', enum: ['set', 'append'], description: 'append is the usual path; set replaces the whole profile.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_learn',
    description:
      'Record a durable lesson about how this person wants things organized ("groceries go under Food, not Housing"). Lessons are filing taste, not who they are. Shown to every future organizing pass and must be obeyed.',
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
      'Pose ONE short question about a detail the capture left out that would make the page more useful: a missing time ("what time is he coming?"), a missing amount, a missing date, or which space something belongs in. Two shapes: give 2-4 options when the answer is a choice, and each must be a complete standalone statement that resolves it ("Groceries go under Food") because tapping files as if typed; give NO options when the answer is a time, an amount, or a date, and the person types it. One slot: a new ask replaces the old. Always file your best guess anyway — never leave a capture waiting on an answer.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'omit entirely for a typed answer (a time, an amount, a date)' },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_surface',
    description:
      'Pin up to three things that deserve the person\'s attention today or tomorrow, each with a short plain label, a few-words reason, the space it lives in, and until (YYYY-MM-DD, the last day it stays relevant). A new call replaces the whole set; an empty list clears it. Surfacing something irrelevant is worse than surfacing nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              reason: { type: 'string' },
              space: { type: 'string' },
              until: { type: 'string' },
            },
            required: ['label', 'reason', 'space'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_pin',
    description:
      'Pin or unpin a space. A pinned space sits near the top of the page all year, above everything except things that are actually due. Pin only what the person has said matters most; unpin when they say it no longer does.',
    inputSchema: {
      type: 'object',
      properties: { space: { type: 'string' }, pinned: { type: 'boolean' } },
      required: ['space', 'pinned'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_set_goal',
    description:
      "Set a goal: a target laid over a block the page already has (a tracker, ledger, streak, or list), never a second counter. Use when the person names a total they want to reach over the year or by a date: 'my goal this year is 200 miles', 'read 12 books by December', 'save $10,000 by October'. Give the space; name blockId only when the space holds more than one countable block. Omit `by` for a calendar-year goal; give by (YYYY-MM-DD) for a nearer horizon. target 0 lifts the goal. Progress on a goal is always logged in its block with that block's own verb (move_tracker, log_amount, mark_day, add_or_check) — never here.",
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string' },
        blockId: { type: 'string' },
        target: { type: 'number', description: 'the total to reach; 0 lifts the goal' },
        unit: { type: 'string', description: 'how the person counts it: miles, books, $' },
        by: { type: 'string', description: 'horizon YYYY-MM-DD; omit for the calendar year' },
      },
      required: ['space', 'target'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_move_goal',
    description:
      "Move a space's goal onto a different block — the conversion motion, for when the person starts counting a goal in a new shape: '200 miles' lived on a bare tracker, they begin logging individual runs, the goal moves onto that ledger (create the right block first if the space lacks it). Where the goal stands NEVER changes: progress the old carrier held rides along. A plain tracker that only mirrored the goal is absorbed into it; carriers holding the person's own words (entries, items, dates) stay. Give blockId only when the space carries more than one goal.",
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string' },
        blockId: { type: 'string', description: 'the goal to move, when the space has several' },
        toBlockId: { type: 'string', description: 'the block that counts it from now on' },
      },
      required: ['space', 'toBlockId'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_finish',
    description:
      'Archive a space (or reopen an archived one). An archived space keeps everything it holds and moves to the Archive fold at the bottom of the page. Only archive one when the person says so; never as tidying.',
    inputSchema: {
      type: 'object',
      properties: { space: { type: 'string' }, finished: { type: 'boolean' } },
      required: ['space', 'finished'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_rename',
    description:
      'Rename a space, or reword one block or list item, when the person asks for different wording. Give either spaceId, or blockId (with itemId for one item in a list).',
    inputSchema: {
      type: 'object',
      properties: {
        spaceId: { type: 'string' },
        blockId: { type: 'string' },
        itemId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_set_area',
    description:
      'Group a space under a short area of life ("Money", "Health", "Work", "Home", "Learning"). Areas let the page organize its own spaces once there are many. Reuse existing area names; invent a new one only for genuinely new territory. Keep the total number of areas small.',
    inputSchema: {
      type: 'object',
      properties: { space: { type: 'string' }, area: { type: 'string' } },
      required: ['space', 'area'],
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
      return core.agentView()
    // the six small per-type verbs, translated to one internal patch
    case 'december_add_or_check':
    case 'december_move_tracker':
    case 'december_log_amount':
    case 'december_mark_day':
    case 'december_write_note':
    case 'december_set_reminder': {
      const v = verbPatch(name, args)
      return core.updateBlock(v.blockId, v.patch, v.type, name.slice('december_'.length))
    }
    case 'december_read_block':
      return core.readBlock(args.blockId)
    case 'december_capture':
      return core.addCapture(args.text)
    case 'december_create_space':
      return core.createSpace(args.name)
    case 'december_create_block': {
      const { space, ...spec } = args
      return core.createBlock(space, spec)
    }
    case 'december_retitle':
      return core.updateBlock(args.blockId, { retitle: args.title }, undefined, 'retitle')
    case 'december_file_capture':
      return core.fileCapture(args.captureId, args.space, args.summary)
    case 'december_write_about':
      return core.writeAbout(args.text, args.mode || 'append')
    case 'december_learn':
      return core.addLesson(args.lesson)
    case 'december_suggest':
      return core.setSuggestions(args.suggestions)
    case 'december_ask':
      return core.setAsk(args.question, args.options)
    case 'december_surface':
      return core.setSurfaced(args.items)
    case 'december_set_area':
      return core.setArea(args.space, args.area)
    case 'december_pin':
      return core.setPinnedByRef(args.space, args.pinned)
    case 'december_finish':
      return core.setFinishedByRef(args.space, args.finished)
    case 'december_set_goal':
      return core.setGoal(args)
    case 'december_move_goal':
      return core.moveGoal(args)
    case 'december_rename':
      return core.editText(args, 'rename')
    case 'december_undo':
      await core.undo()
      return { ok: true }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
