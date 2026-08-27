import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../public/js/connections.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/css/settings.css', import.meta.url), 'utf8')

function loadPickerState() {
  const match = source.match(/\/\/ Model picker: pure state start\s+([\s\S]*?)\/\/ Model picker: pure state end/)
  assert.ok(match, 'model picker state block is present')
  const body = match[1].replaceAll('export ', '')
  return Function(`${body}\nreturn { MODEL_SEEDS, CUSTOM_MODEL_VALUE, modelPickerState, modelPickerSelection, customModelValue }`)()
}

const {
  MODEL_SEEDS,
  CUSTOM_MODEL_VALUE,
  modelPickerState,
  modelPickerSelection,
  customModelValue,
} = loadPickerState()

test('model choices are seeded once with the supported values for each engine', () => {
  assert.deepEqual(MODEL_SEEDS.claude, ['', 'sonnet', 'opus', 'haiku'])
  assert.deepEqual(MODEL_SEEDS.codex, ['', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
  assert.ok(Object.isFrozen(MODEL_SEEDS))
  assert.ok(Object.values(MODEL_SEEDS).every(Object.isFrozen))
})

test('empty model is the explicit engine-default choice', () => {
  for (const engine of ['claude', 'codex']) {
    assert.deepEqual(modelPickerState(engine, ''), {
      models: MODEL_SEEDS[engine],
      model: '',
      custom: false,
      selected: '',
    })
  }
  assert.deepEqual(modelPickerSelection(''), { custom: false, model: '' })
})

test('saved seeded values select normally and unknown values reopen as Custom without loss', () => {
  assert.equal(modelPickerState('claude', 'opus').selected, 'opus')
  assert.equal(modelPickerState('codex', 'gpt-5.6-terra').selected, 'gpt-5.6-terra')

  const unknown = modelPickerState('codex', 'vendor/future-model')
  assert.equal(unknown.selected, CUSTOM_MODEL_VALUE)
  assert.equal(unknown.custom, true)
  assert.equal(unknown.model, 'vendor/future-model')
})

test('engine switching refreshes choices but never rewrites the saved model', () => {
  const saved = 'sonnet'
  const claude = modelPickerState('claude', saved)
  const codex = modelPickerState('codex', saved)
  const backToClaude = modelPickerState('claude', codex.model)

  assert.equal(claude.selected, 'sonnet')
  assert.equal(codex.selected, CUSTOM_MODEL_VALUE)
  assert.equal(codex.model, saved)
  assert.equal(backToClaude.selected, saved)
  assert.match(source, /renderModelPicker\(\{ \.\.\.currentSettings, engine: key \}\)/)
  assert.match(source, /saveSettings\(\{ engine: key \}\)/)
  assert.doesNotMatch(source, /saveSettings\(\{ engine: key, model:/)
})

test('Custom reveals editing without saving a sentinel and saves an exact trimmed value', () => {
  assert.deepEqual(modelPickerSelection(CUSTOM_MODEL_VALUE), { custom: true })
  assert.deepEqual(modelPickerSelection('haiku'), { custom: false, model: 'haiku' })
  assert.equal(customModelValue('  vendor/model-preview  '), 'vendor/model-preview')
  assert.match(source, /if \(selection\.custom\) \{[\s\S]*?modelInput\.hidden = false[\s\S]*?modelInput\.focus\(\)[\s\S]*?return/)
  assert.match(source, /saveSettings\(\{ model: customModelValue\(event\.target\.value\) \}\)/)
})

test('the stable model input is enhanced into an accessible keyboard picker', () => {
  assert.match(html, /<input class="set-input" id="model-input"/)
  assert.match(source, /document\.createElement\('select'\)/)
  assert.match(source, /modelSelect\.setAttribute\('aria-labelledby', modelLabel\.id\)/)
  assert.match(source, /modelInput\.setAttribute\('aria-label', 'Custom model'\)/)
  assert.match(source, /select:not\(:disabled\)/)
  assert.doesNotMatch(`${html}\n${source}`, /<datalist|createElement\('datalist'\)/)
  assert.match(css, /\.set-input:focus \{[^}]*box-shadow: var\(--focus-ring-field\)/)
  assert.match(css, /\.model-picker \.set-input/)
})
