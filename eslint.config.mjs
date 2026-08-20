// The guardrail the page modules were missing: node --check parses, but only
// a scope-aware pass catches a name used without its import — the exact class
// of bug that broke inline edits (markEdited) and the Clean Slate commit
// (coAnswered). Two rules, no style opinions: prettier-ish taste stays human.
import globals from 'globals'

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
}

export default [
  { ignores: ['node_modules/**', 'release/**', 'data/**'] },
  {
    // the page: native ES modules in the browser
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules,
  },
  {
    // the server side, the adapters, the tests
    files: ['*.mjs', 'lib/**/*.mjs', 'electron/**/*.mjs', 'test/**/*.mjs', 'skills/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules,
  },
]
