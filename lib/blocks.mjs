// The six block types, each fully defined in ONE table entry:
// make (from an agent spec), update (apply a patch), project (derived
// fields for rendering), and the schema fragment its tools advertise.
// Adding a seventh type touches this file and nothing else.

export const uid = () => Math.random().toString(36).slice(2, 9)

const today = () => new Date().toISOString().slice(0, 10)

export const BLOCKS = {
  list: {
    doc: 'checkable items',
    fields: {
      items: { type: 'array', items: { type: 'string' }, description: 'list: initial items' },
    },
    make: (spec) => ({
      items: (spec.items || []).slice(0, 30).map((t) => ({ id: uid(), text: String(t).slice(0, 200), done: false, src: spec.source || '' })),
    }),
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
      unit: { type: 'string', description: 'tracker: e.g. "payments", "books"' },
      period: { type: 'string', enum: ['year'], description: "tracker: 'year' when the target is a by-December goal — the bar gains a today marker" },
    },
    make: (spec) => ({
      current: Math.max(0, Number(spec.current) || 0),
      target: Math.max(1, Number(spec.target) || 1),
      unit: spec.unit ? String(spec.unit).slice(0, 20) : '',
      period: spec.period === 'year' ? 'year' : '',
    }),
    update: (b, p) => {
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
    update: (b, p) => {
      const d = p.mark_date || today()
      if (!b.dates.includes(d)) b.dates.push(d)
    },
  },

  note: {
    doc: 'kept prose',
    fields: { text: { type: 'string', description: 'note/reminder: the content' } },
    make: (spec) => ({ text: String(spec.text || '').slice(0, 4000) }),
    update: (b, p) => {
      if (p.note_text != null) {
        b.text = p.note_mode === 'append' ? `${b.text}\n${p.note_text}`.slice(0, 4000) : String(p.note_text).slice(0, 4000)
      }
    },
  },

  reminder: {
    doc: 'a line that resurfaces until done; give it when (YYYY-MM-DD) if it implies a date, and repeat if it recurs',
    fields: {
      when: { type: 'string', description: 'reminder: due date YYYY-MM-DD, when the capture implies one' },
      repeat: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'], description: 'reminder: recurrence, when the capture implies one ("every month")' },
    },
    make: (spec) => ({
      text: String(spec.text || spec.title || '').slice(0, 200),
      done: false,
      when: spec.when ? String(spec.when).slice(0, 10) : '',
      repeat: ['daily', 'weekly', 'monthly', 'yearly'].includes(spec.repeat) ? spec.repeat : '',
    }),
    update: (b, p) => {
      if (p.reminder_done != null) b.done = !!p.reminder_done
      if (p.reminder_when != null) b.when = String(p.reminder_when).slice(0, 10)
      if (p.reminder_repeat != null) b.repeat = ['daily', 'weekly', 'monthly', 'yearly', ''].includes(p.reminder_repeat) ? p.reminder_repeat : b.repeat
    },
  },
}

export const BLOCK_TYPES = Object.keys(BLOCKS)

export function makeBlock(spec) {
  const def = BLOCKS[spec?.type]
  if (!def) return null
  return { id: uid(), type: spec.type, title: String(spec.title || '').slice(0, 80), ...def.make(spec) }
}

export function updateBlock(block, patch) {
  const def = BLOCKS[block.type]
  if (!def) return
  def.update(block, patch)
  if (patch.retitle != null) block.title = String(patch.retitle).slice(0, 80)
}

export function projectBlock(block) {
  const def = BLOCKS[block.type]
  return def?.project ? { ...block, ...def.project(block) } : block
}

/** Assemble create-block schema properties from the per-type fragments. */
export function createBlockFields() {
  const fields = {}
  for (const def of Object.values(BLOCKS)) Object.assign(fields, def.fields)
  return fields
}

export const typeDocs = () =>
  BLOCK_TYPES.map((t) => `${t} (${BLOCKS[t].doc})`).join(', ')
