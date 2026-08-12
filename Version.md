---
enabled: true
current: 0.6.0
dev_flow: formal
test_gate: local
---

# December — Version History

## 0.6.0 — 2026-08-12

The page gained a horizon, a month you can open, and an ending.

The attention strip could only see as far as tomorrow, so a page holding
eight dated things could tell you about none of them; it now reads a week in
two bands, today and this week, and measures itself to fit rather than
trusting a fixed row budget. Months became a place you can walk into: a new
/api/month route reads what a month actually held, grouped by the space it
happened in, and the year view collapses empty runs instead of printing
"quiet" seven times. Everything finished, resting or retired folded from
twenty full-width rows into a single line of counts that opens into a month
grouping, taking the page from 3587px to 2826px. First boot became one
moment instead of two. The stage says "working" while the agent works rather
than reading your own sentence back to you. The dateline says how far the
year has to go. The running release now shows beside About December (#14).

Fixes: yearSummary counted a filed capture and the entry it became, so a
month claimed 12 moments and opening it showed 7; /api/month/2026-13 was
accepted; the stage was scrollable behind a hidden scrollbar; jumpToSpace
relied on smooth scrolling that is a silent no-op in some browsers; a
duplicate CSS rule restored a margin an earlier fix removed; money was
formatted in two places, differently; the rail stranded its own bottom
entries behind sticky positioning on a short window.

Typography: the sans slot named a face that was never shipped and is not
installed on a normal machine, so the app always drew in system-ui and
looked different depending on who opened it. It names the platform face
honestly now, with Georgia kept for display numerals and month labels.

Craft: one press scale where there were three, real hit areas on the card
corner tools, balanced headings, and a dateline rule that draws itself.

Merged through PRs #14 and #15. Tests 26/26 local.

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
