---
enabled: true
current: 0.4.0
dev_flow: formal
test_gate: local
---

# December — Version History

## 0.2.0 — 2026-08-12

Engine settings gear (Claude persistent agent or one-shot Codex, free-text
model override, persisted server-side), file drop intake (uploads +
zero-dependency .docx text extraction, settle agent reads attached files),
Windows engine support (direct .exe spawn, stderr-tail errors), and
multi-instance safety (port-suffixed MCP config pinned via DECEMBER_URL).
First version integrated through Formal Flow (PR #3, squash-merged).

## 0.1.0 — 2026-08-12

Baseline stamp at formalization. December is a zero-dependency Node web app —
one page where raw text is captured and a subscription-powered agent organizes
it into spaces of six block types (list, tracker, ledger, streak, note,
reminder) — plus a stdio MCP adapter so any connected assistant works the same
page. This version marks the repo's promotion to Formal Flow (branch → PR →
squash-merge) and the application of the public repo profile.
