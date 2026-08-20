import globals from 'globals'

const correctnessRules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
}

export default [
  { ignores: ['node_modules/**', 'release/**', 'data/**'] },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: correctnessRules,
  },
  {
    files: ['*.mjs', 'lib/**/*.mjs', 'electron/**/*.mjs', 'test/**/*.mjs', 'skills/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: correctnessRules,
  },
]
