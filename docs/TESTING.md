# Testing — December

**Canonical suite** (the `test_gate: local` gate in `Version.md`):

```bash
node --test
```

(Default discovery picks up `test/*.test.mjs`.)

Zero dependencies, like the app: the suite runs on Node's built-in `node:test`
runner and `node:assert`. No package.json, no runner install.

## What's covered

- `test/blocks.test.mjs` — the six-block-type table: make/update contracts,
  clamping, unknown-type rejection.
- `test/docx.test.mjs` — dropped-document text extraction against a real
  in-memory zip; corrupt and empty documents rejected.
- `test/settings.test.mjs` — gear settings validation: known engines only,
  defensive copies, engine metadata.

## Rules

- Run the suite before every commit (`test_gate: local`). Never commit over a
  red suite; never fix a failure by weakening an assertion.
- Tests must not touch `data/state.json` or any live page state. Pure-logic
  modules only; the running app exercises persistence.
- Quality exemptions (skips, disabled assertions) require a `QX-` entry in
  `docs/quality-exemptions.md` per the workspace Test-Master policy.
