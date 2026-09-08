const LIVE_FIELDS = ['settle', 'canUndo', 'canUndoManual']
export function reconcileState(current, incoming) {
  if (!incoming || typeof incoming !== 'object') return current
  if (
    Number.isSafeInteger(current?.revision) &&
    (!Number.isSafeInteger(incoming.revision) || incoming.revision < current.revision)
  ) return current
  if (incoming.unchanged) {
    if (!current) return current
    const next = { ...current }
    for (const field of ['fingerprint', ...LIVE_FIELDS]) {
      if (Object.hasOwn(incoming, field)) next[field] = incoming[field]
    }
    return next
  }
  // An interrupted or proxy-truncated response must not erase the page.
  if (!Array.isArray(incoming.spaces) || !Array.isArray(incoming.captures)) return current
  const next = { ...incoming }
  for (const field of LIVE_FIELDS) {
    if (!Object.hasOwn(incoming, field) && Object.hasOwn(current || {}, field)) next[field] = current[field]
  }
  return next
}
