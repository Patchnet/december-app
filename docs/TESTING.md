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
  verb translation, entity validation, clamping, unknown-type rejection.
- `test/core.test.mjs` — event append/read, pin and finish behavior, injected-
  clock rollover, legacy-state compatibility, and inline-edit undo.
- `test/docx.test.mjs` — dropped-document text extraction against a real
  in-memory zip; corrupt and empty documents rejected.
- `test/settings.test.mjs` — gear settings validation: known engines only,
  defensive copies, engine metadata.
- `test/connect.test.mjs` — isolated client-config round trips, Claude
  Desktop backup behavior, forward-slash Codex TOML, skill version publishing,
  detection/status shape, and the non-interactive wizard. Every home and app
  data directory in these tests is a disposable fixture.
- `test/settle.test.mjs` — robust surfacing-array extraction and item
  validation.

- `test/desktop-runtime.test.mjs` — data-directory resolution, CLI path
  resolution for GUI launches, and the desktop fixed-port decision.
- `test/page-modules.test.mjs` — the page is native ES modules under
  `public/js/` (no bundler). Boot file stays small, styles.css only
  `@import`s sheets, modules parse, stay under the landing cap, and
  do not import each other in a cycle.

## Desktop smoke checklist

After `npm install`, exercise Electron behavior manually:

1. Run `npm run app`; confirm the main page opens and the December tray icon
   appears.
2. On a fresh Electron profile, confirm onboarding reports detected CLIs
   honestly and offers capture-only mode when neither is available.
3. Press `Ctrl+Alt+D`; confirm the window opens, rises to the front, and the
   capture field has focus. Repeat from the tray's **Capture** command.
4. Submit a capture; confirm it lands immediately. If the selected CLI is
   available, confirm it settles. Otherwise confirm it stays saved with a
   `capture only` status and no crash.
5. Close the window, reopen it from the tray, then choose **Quit** and confirm
   the local server stops.
6. Run `node server.mjs` without Electron and confirm `/api/health` responds on
   port 3008.
7. Run `npm run dist:win` and confirm an unsigned NSIS installer exists in
   `release/`.

## Rules

- Run the suite before every commit (`test_gate: local`). Never commit over a
  red suite; never fix a failure by weakening an assertion.
- Tests must not touch `data/state.json` or any live page state. Pure-logic
  modules only; the running app exercises persistence.
- Quality exemptions (skips, disabled assertions) require a `QX-` entry in
  `docs/quality-exemptions.md` per the workspace testing policy.
