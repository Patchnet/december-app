export function buildEngineChoices(definitions, settings = {}) {
  const selectedKey = settings.engine
  const availableKeys = definitions
    .filter((engine) => Boolean(settings.engines?.[engine.key]))
    .map((engine) => engine.key)
  const focusKey = availableKeys.includes(selectedKey) ? selectedKey : (availableKeys[0] || null)

  return definitions.map((engine) => {
    const available = availableKeys.includes(engine.key)
    return {
      ...engine,
      available,
      selected: engine.key === selectedKey,
      disabled: !available,
      tabIndex: available && engine.key === focusKey ? 0 : -1,
    }
  })
}

export function nextEngineKey(choices, currentKey, key) {
  const available = choices.filter((choice) => !choice.disabled)
  if (!available.length) return null
  if (key === 'Home') return available[0].key
  if (key === 'End') return available.at(-1).key

  const direction = ['ArrowRight', 'ArrowDown'].includes(key)
    ? 1
    : ['ArrowLeft', 'ArrowUp'].includes(key) ? -1 : 0
  if (!direction) return null

  const currentIndex = available.findIndex((choice) => choice.key === currentKey)
  const start = currentIndex === -1 ? 0 : currentIndex
  return available[(start + direction + available.length) % available.length].key
}
