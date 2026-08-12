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

- `test/desktop-runtime.test.mjs` — data-directory resolution, CLI path
  resolution for GUI launches, and the desktop fixed-port decision.

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
  `docs/quality-exemptions.md` per the workspace Test-Master policy.
