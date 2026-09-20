# Experimental Jev preview

Jev is optional and off during ordinary server startup. The integration supports bounded explicit list additions and named checklists; the selected Claude Code or Codex organizer handles broader work. See [architecture](JEV-ARCHITECTURE.md).

## Local review

Requires Node >=22.13, npm, your own TypeSafe/Jev access and an authenticated supported CLI for organizer fallback.

```sh
npm ci --ignore-scripts
npm run setup:jev
npm run preview:jev
```

Open localhost:3007. Override PORT if needed. The setup helper reads the key without echo and writes it only to ignored data/credentials/typesafe.key, refusing overwrites. Alternatively configure TYPESAFE_API_KEY_FILE or inject TYPESAFE_API_KEY. Do not put credentials in source or shell history. No .env loader is provided. macOS/Linux file permissions are owner-only; use appropriate account ACLs on Windows.

The launcher creates a fresh sample page under data/jev-live-preview. Never copy a populated data directory into a PR. npm run preview:simulate uses separately labeled canned examples, not a real model. npm ci --ignore-scripts skips Electron installation for browser-only review; desktop development needs npm rebuild electron.

Examples: Add oat milk to Groceries; Add apples, coffee, and rice to Groceries; Make a Garden checklist: water herbs, repot basil, buy compost. Use a general note to exercise fallback.

Settings reports configured Jev status and detected CLI installations. Check setup does not authenticate the CLIs or run inference. In-app key entry, provider connection testing and public onboarding remain unfinished. Missing fallback credentials can leave broader captures pending.

The key stays server-side, but live requests transmit capture text and bounded list/name context to TypeSafe; fallback work goes to the chosen CLI/provider. Use synthetic data when reviewing. The local HTTP server is not intended to be exposed publicly.

Run npm test. The optional Relay contract requires DECEMBER_RELAY_ROOT. Desktop distribution and live Pocket pairing need separate verification. The confidence gate is experimental, not a calibrated reliability guarantee.
