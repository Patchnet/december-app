// The six block types, each fully defined in ONE table entry:
// make (from an agent spec), update (apply a patch), project (derived
// fields for rendering), and the schema fragment its tools advertise.
// Adding a seventh type touches this file and nothing else.

export const uid = () => Math.random().toString(36).slice(2, 9)

const today = () => new Date().toISOString().slice(0, 10)
const ENTITY_TYPES = ['person', 'org', 'place', 'thing']

export const entitiesField = {
  type: 'array',
  maxItems: 8,
  description: 'People, organizations, places, or distinct things explicitly named in the capture. Use short normalized names; never invent them.',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ENTITY_TYPES },
      name: { type: 'string', maxLength: 60 },
    },
    required: ['type', 'name'],
    additionalProperties: false,
  },
}

export function validateEntities(value) {
  if (!Array.isArray(value)) throw new Error('entities must be an array')
  if (value.length > 8) throw new Error('entities must contain at most 8 entries')
  return value.map((entity) => {
    if (!entity || Array.isArray(entity) || typeof entity !== 'object') throw new Error('each entity must be an object')
    if (Object.keys(entity).some((key) => key !== 'type' && key !== 'name')) throw new Error('an entity accepts only type and name')
    if (!ENTITY_TYPES.includes(entity.type)) throw new Error(`unknown entity type: ${entity.type}`)
    if (typeof entity.name !== 'string') throw new Error('entity name must be a string')
    const name = entity.name.trim()
    if (!name || name.length > 60) throw new Error('entity name must be 1-60 characters after trimming')
    return { type: entity.type, name }
  })
}

export const BLOCKS = {
  list: {
    doc: 'checkable items',
    fields: {
      items: { type: 'array', items: { type: 'string' }, description: 'list: initial items' },
    },
    make: (spec) => ({
      items: (spec.items || []).slice(0, 30).map((t) => ({ id: uid(), text: String(t).slice(0, 200), done: false, src: spec.source || '' })),
    }),
    verb: {
      name: 'add_or_check',
      doc: 'add items to a list, or check and uncheck the ones already in it',
      params: {
        add: { type: 'array', items: { type: 'string' }, description: 'new items to add' },
        check: { type: 'array', items: { type: 'string' }, description: 'item ids to mark done' },
        uncheck: { type: 'array', items: { type: 'string' }, description: 'item ids to mark not done' },
      },
      map: (a) => ({ add_items: a.add, check_item_ids: a.check, uncheck_item_ids: a.uncheck }),
    },
    update: (b, p) => {
      for (const t of p.add_items || []) b.items.push({ id: uid(), text: String(t).slice(0, 200), done: false, src: p.source || '' })
      for (const id of p.check_item_ids || []) {
        const it = b.items.find((i) => i.id === id)
        if (it) (it.done = true), (it.doneAt = new Date().toISOString())
      }
      for (const id of p.uncheck_item_ids || []) {
        const it = b.items.find((i) => i.id === id)
        if (it) (it.done = false), (it.doneAt = null)
      }
    },
  },

  tracker: {
    doc: 'progress toward a numeric target (8 of 12 rent payments)',
    fields: {
      current: { type: 'number', description: 'tracker: starting value' },
      target: { type: 'number', description: 'tracker: the goal (12 monthly payments = 12)' },
      unit: { type: 'string', description: 'tracker: e.g. "payments", "books". Pick the unit the person counts in — 25 minutes of practice is 25 minutes, not 0.42 hours.' },
      goal: { type: 'boolean', description: "tracker: true when the person names this as a goal they want to reach ('my goal this year is 200 miles', '24 books by December'). The page then shows it over the cards and paces it; target is the goal." },
      by: { type: 'string', description: 'tracker goal: horizon YYYY-MM-DD; omit for the calendar year' },
      period: { type: 'string', enum: ['year'], description: "tracker: 'year' ONLY when the count accumulates steadily toward a December total (miles run, books read, hours practiced). The page then shows whether they are ahead or behind pace, so do NOT set it for a fixed schedule (12 monthly rent payments) or a few discrete events (4 checkups) — those cannot be ahead of pace." },
    },
    make: (spec) => ({
      current: Math.max(0, Number(spec.current) || 0),
      target: Math.max(1, Number(spec.target) || 1),
      unit: spec.unit ? String(spec.unit).slice(0, 20) : '',
      period: spec.period === 'year' ? 'year' : '',
    }),
    verb: {
      name: 'move_tracker',
      doc: 'move a tracker: add to it, or set where it stands, or change its target',
      params: {
        delta: { type: 'number', description: 'add this much to the current value (usually 1)' },
        current: { type: 'number', description: 'set the current value outright' },
        target: { type: 'number', description: 'change the goal' },
        period: { type: 'string', enum: ['year', ''], description: "'year' if this accumulates steadily toward a December total, or empty to clear it when it does not — use this to correct a tracker whose shape was wrong" },
      },
      map: (a) => ({ delta: a.delta, set_current: a.current, set_target: a.target, set_period: a.period }),
    },
    update: (b, p) => {
      if (p.set_period != null) b.period = p.set_period === 'year' ? 'year' : ''
      if (p.set_target != null) b.target = Math.max(1, Number(p.set_target) || b.target)
      if (p.set_current != null) b.current = Math.max(0, Number(p.set_current) || 0)
      if (p.delta != null) b.current = Math.max(0, b.current + (Number(p.delta) || 0))
    },
  },

  ledger: {
    doc: 'running log of amounts with a total (money, miles, pages)',
    fields: {
      unit: { type: 'string', description: 'ledger: currency or unit symbol, default "$"' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, amount: { type: 'number' } },
          required: ['label', 'amount'],
          additionalProperties: false,
        },
        description: 'ledger: initial entries',
      },
    },
    make: (spec) => ({
      unit: spec.unit ? String(spec.unit).slice(0, 8) : '$',
      entries: (spec.entries || []).slice(0, 50).map((e) => ({
        id: uid(),
        label: String(e.label || '').slice(0, 80),
        amount: Number(e.amount) || 0,
        at: new Date().toISOString(),
        src: spec.source || '',
      })),
    }),
    verb: {
      name: 'log_amount',
      doc: 'log one amount into a ledger',
      params: {
        label: { type: 'string', description: 'what it was' },
        amount: { type: 'number', description: 'how much' },
      },
      required: ['label', 'amount'],
      map: (a) => ({ entry_label: a.label, entry_amount: a.amount }),
    },
    update: (b, p) => {
      if (p.entry_label != null || p.entry_amount != null) {
        b.entries.push({ id: uid(), label: String(p.entry_label || '').slice(0, 80), amount: Number(p.entry_amount) || 0, at: new Date().toISOString(), src: p.source || '' })
      }
    },
    project: (b) => ({ total: b.entries.reduce((n, e) => n + (Number(e.amount) || 0), 0) }),
  },

  streak: {
    doc: 'a did-it-today habit, marked by date',
    fields: {
      dates: { type: 'array', items: { type: 'string' }, description: 'streak: ISO dates already done' },
    },
    make: (spec) => ({ dates: (spec.dates || []).slice(0, 400).map(String) }),
    verb: {
      name: 'mark_day',
      doc: 'mark a day done on a streak',
      params: { date: { type: 'string', description: 'YYYY-MM-DD; today if omitted' } },
      map: (a) => ({ mark_date: a.date }),
    },
    update: (b, p) => {
      const d = p.mark_date || today()
      if (!b.dates.includes(d)) b.dates.push(d)
    },
  },

  note: {
    doc: 'kept prose',
    fields: { text: { type: 'string', description: 'note/reminder: the content' } },
    make: (spec) => ({ text: String(spec.text || '').slice(0, 4000) }),
    verb: {
      name: 'write_note',
      doc: 'set or append the text of a note',
      params: {
        text: { type: 'string' },
        mode: { type: 'string', enum: ['set', 'append'], description: 'default set' },
      },
      required: ['text'],
      map: (a) => ({ note_text: a.text, note_mode: a.mode }),
    },
    update: (b, p) => {
      if (p.note_text != null) {
        b.text = p.note_mode === 'append' ? `${b.text}\n${p.note_text}`.slice(0, 4000) : String(p.note_text).slice(0, 4000)
      }
    },
  },

  reminder: {
    doc: 'a line that resurfaces until done; give it when (YYYY-MM-DD), at (HH:MM) if a clock time is implied, and repeat if it recurs',
    fields: {
      when: { type: 'string', description: 'reminder: due date YYYY-MM-DD, when the capture implies one' },
      at: { type: 'string', description: 'reminder: clock time HH:MM in 24h, when the capture names one ("9am", "at 3:30")' },
      repeat: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'], description: 'reminder: recurrence, when the capture implies one ("every month")' },
    },
    make: (spec) => ({
      text: String(spec.text || spec.title || '').slice(0, 200),
      done: false,
      when: spec.when ? String(spec.when).slice(0, 10) : '',
      at: /^\d{2}:\d{2}$/.test(spec.at || '') ? spec.at : '',
      repeat: ['daily', 'weekly', 'monthly', 'yearly'].includes(spec.repeat) ? spec.repeat : '',
    }),
    verb: {
      name: 'set_reminder',
      doc: 'mark a reminder done, or change when it is due, its clock time, or how it repeats',
      params: {
        done: { type: 'boolean' },
        when: { type: 'string', description: 'due date YYYY-MM-DD' },
        at: { type: 'string', description: 'clock time HH:MM, 24h' },
        repeat: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', ''], description: 'empty clears' },
      },
      map: (a) => ({ reminder_done: a.done, reminder_when: a.when, reminder_at: a.at, reminder_repeat: a.repeat }),
    },
    update: (b, p) => {
      if (p.reminder_done != null) b.done = !!p.reminder_done
      if (p.reminder_when != null) b.when = String(p.reminder_when).slice(0, 10)
      if (p.reminder_at != null) b.at = /^\d{2}:\d{2}$/.test(p.reminder_at) ? p.reminder_at : ''
      if (p.reminder_repeat != null) b.repeat = ['daily', 'weekly', 'monthly', 'yearly', ''].includes(p.reminder_repeat) ? p.reminder_repeat : b.repeat
    },
  },
}

export const BLOCK_TYPES = Object.keys(BLOCKS)

export function makeBlock(spec) {
  const def = BLOCKS[spec?.type]
  if (!def) return null
  const entities = Object.hasOwn(spec, 'entities') ? validateEntities(spec.entities) : []
  const block = { id: uid(), type: spec.type, title: String(spec.title || '').slice(0, 80), ...def.make(spec), entities }
  // a tracker born as a goal carries it from the first line
  if (spec.type === 'tracker' && spec.goal === true) setBlockGoal(block, { target: block.target, unit: block.unit, by: spec.by })
  return block
}

export function updateBlock(block, patch) {
  const def = BLOCKS[block.type]
  if (!def) return
  const entities = Object.hasOwn(patch, 'entities') ? validateEntities(patch.entities) : null
  def.update(block, patch)
  if (patch.retitle != null) block.title = String(patch.retitle).slice(0, 80)
  if (entities) block.entities = entities
}

export function projectBlock(block) {
  const def = BLOCKS[block.type]
  const projected = def?.project ? { ...block, ...def.project(block) } : { ...block }
  projected.entities = Array.isArray(block.entities) ? block.entities : []
  if (block.goal) projected.goal = goalOf(block)
  return projected
}

/** Assemble create-block schema properties from the per-type fragments. */
export function createBlockFields() {
  const fields = {}
  for (const def of Object.values(BLOCKS)) Object.assign(fields, def.fields)
  return fields
}

/** One small tool per block type, built from the table above. Every one
    takes a blockId, its own two or three fields, and nothing else. */
export function verbTools() {
  return Object.entries(BLOCKS)
    .filter(([, def]) => def.verb)
    .map(([type, def]) => ({
      name: `december_${def.verb.name}`,
      description: `${def.verb.doc}. Works on a ${type} block; get its id from december_view.`,
      inputSchema: {
        type: 'object',
        properties: {
          blockId: { type: 'string' },
          ...def.verb.params,
          entities: entitiesField,
          source: { type: 'string', description: 'the captureId this came from, so the person can see where it came from' },
        },
        required: ['blockId', ...(def.verb.required || [])],
        additionalProperties: false,
      },
      _type: type,
    }))
}

/** Translate a small tool's arguments into the flat patch update() knows. */
export function verbPatch(toolName, args) {
  for (const def of Object.values(BLOCKS)) {
    if (def.verb && `december_${def.verb.name}` === toolName) {
      const { blockId, source, entities, ...rest } = args
      const type = Object.keys(BLOCKS).find((k) => BLOCKS[k] === def)
      return {
        blockId,
        type,
        patch: {
          ...def.verb.map(rest),
          source,
          ...(Object.hasOwn(args, 'entities') ? { entities } : {}),
        },
      }
    }
  }
  return null
}

export const typeDocs = () =>
  BLOCK_TYPES.map((t) => `${t} (${BLOCKS[t].doc})`).join(', ')

// ------------------------------------------------------------------ goals
// A goal is a target laid over a block the page already has, never a second
// counter. The block is the source; the goal only says where it should end
// up and by when. So "logged this morning's 4 miles" moves the Running
// ledger the way it always did, and the goal follows by derivation. There is
// no separate "update the goal" step for anyone, person or engine, to forget.
const MEASURE = {
  tracker: (b) => b.current,
  ledger: (b) => b.entries.reduce((n, e) => n + (Number(e.amount) || 0), 0),
  streak: (b) => b.dates.length,
  list: (b) => b.items.filter((i) => i.done).length,
}
export const GOAL_TYPES = Object.keys(MEASURE)

/** What a block currently counts to, in the goal's terms. null if it cannot hold one. */
export function goalMeasure(block) {
  const f = MEASURE[block?.type]
  return f ? f(block) : null
}

/** Lay a goal over a block, or lift it (target 0 / null clears). Dates are
    local days. A goal with no horizon runs the calendar year from a base of
    zero; one with a `by` date runs from today and from where the block
    stands now, so pace means "since you said so", not "since January". */
export function setBlockGoal(block, { target, unit, by } = {}, today = localDayOf()) {
  if (!MEASURE[block.type]) throw new Error(`a ${block.type} cannot carry a goal`)
  const t = Number(target)
  if (!t || t <= 0) {
    delete block.goal
    return null
  }
  const year = today.slice(0, 4)
  const horizon = /^\d{4}-\d{2}-\d{2}$/.test(by || '') ? by : `${year}-12-31`
  const bounded = !!(by && horizon !== `${year}-12-31`)
  const was = block.goal
  const goal = {
    target: t,
    unit: String(unit || block.unit || was?.unit || '').slice(0, 20),
    from: bounded ? (was?.by === horizon ? was.from : today) : `${year}-01-01`,
    by: horizon,
    base: bounded ? (was?.by === horizon ? was.base : goalMeasure(block)) : 0,
    setAt: was?.setAt || today,
    movedAt: was?.movedAt || null,
    ...(was?.carried ? { carried: was.carried } : {}),
  }
  // a tracker has one target, not two
  if (block.type === 'tracker') block.target = t
  block.goal = goal
  return goal
}

/** The goal as the page and the engine read it: where it stands, where it
    should stand today, and whether that is ahead or behind. `carried` is
    progress from before this block became the carrier — a goal moved from
    a tracker to a ledger keeps every mile it had already counted. */
export function goalOf(block, now = new Date()) {
  if (!block?.goal) return null
  const g = block.goal
  const current = Math.round(((g.carried || 0) + goalMeasure(block)) * 10) / 10
  const target = block.type === 'tracker' ? block.target : g.target
  const start = new Date(`${g.from}T00:00:00`)
  const end = new Date(`${g.by}T23:59:59`)
  const through = Math.min(1, Math.max(0, (now - start) / Math.max(1, end - start)))
  const expected = g.base + (target - g.base) * through
  const diff = Math.round((current - expected) * 10) / 10
  return {
    current, target, unit: g.unit, from: g.from, by: g.by, base: g.base,
    through, expected: Math.round(expected * 10) / 10, diff,
    met: current >= target, movedAt: g.movedAt, setAt: g.setAt,
  }
}

function localDayOf(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
