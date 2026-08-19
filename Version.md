---
enabled: true
current: 0.10.0
dev_flow: formal
test_gate: local
---

# Version History

## 0.10.0 - 2026-08-18

Archive finished work without deleting it, and give the page a person.
Done list items and one-shot reminders leave the dashboard; they stay in
focus and in the Archive fold. A do-only card falls off when its last
open task is checked. Spaces that hold notes or ledgers stay, and every
card can still be archived on purpose. The corner gear is a letter —
the first letter of About Me, or D — that opens an editable markdown
profile and Settings. Settle and the visiting skill read that profile
and may append standing facts.

## 0.9.1 - 2026-08-14

Fix a fatal boot crash. The page modularization left one bare `state`
reference in the block renderer, so every page with real content died with
"could not load: state is not defined" — invisible on an empty page, which
is why it shipped. One line, plus a static guard that fails on any bare
`state.` across the page modules.

## 0.9.0 - 2026-08-14

Add the local Pocket pairing experience, assisted Windows installer, and fresh-boot regression protection.

## 0.8.0 — 2026-08-14

The page leaves the desk. Pocket synchronization lands its desktop half:
every durable page write queues an encrypted revision for the relay (the
relay never sees the content key), pending uploads survive restarts without
ever blocking local-first writes, and phone captures import idempotently
before their cursors acknowledge. Pair, status, sync, and disconnect wait
under `/api/pocket` for the settings surface. Underneath, the page itself
became modules: a 48-line boot file over native ES modules and split
stylesheets, with an integrity test keeping the boot small and the imports
acyclic. The pocket credential file is gitignored the day it is born.

## 0.7.1 — 2026-08-12

The polish round, from an afternoon of the operator actually living in the
app. The rail is a flat list of pointers again, and clicking one lands with
a quiet accent ring on the card it names. What you type queues visibly under
the input the instant you press Enter — the stage never goes blank — and the
working line breathes. The undo button wears the house's clothes instead of
the browser's. Visiting assistants and the settle pass alike now refuse to
file connective clauses as items. The README carries the mark, the desktop
app's documentation, and a proper tests heading. And the packaged app can
finally read its own version, so the About chip tells the truth in the
builds people actually install.

## 0.7.0 — 2026-08-12

December meets its neighbors. One step — the connect wizard or the gear's new
Connections cards — registers the page with Claude Code, Claude Desktop,
Codex, or Cursor, publishes December's small house-manners skill beside each,
and verifies the result. First-run setup shows the same cards with client
logos; ChatGPT appears honestly as not-yet-connectable until sync arrives.
Zero new dependencies; twelve new tests that never touch your real configs.
Also rolls up the README letter (#18).

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
