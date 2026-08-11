# December

You write. It organizes itself.

One page. You type raw text at the top left — it lands instantly — and an
agent settles it behind you into **spaces** composed from six block types:
list, tracker, ledger, streak, note, reminder. The frame is the year: what
will you have done by December?

```bash
node server.mjs        # http://localhost:3008
```

Zero dependencies, no build step. The intelligence is **your own
subscription**, not an API key: the settle pass is a `claude -p` run connected
to December's MCP tool surface, and any assistant you already use can connect
to the same tools.

## Connect your Claude

```bash
claude mcp add december -- node ~/december-public/mcp-server.mjs
```

(Claude Desktop: add that command under `mcpServers`.) Then ask Claude things
like "what's on my December?" or "log my September rent" — it reads and
writes the same page through the same tools.

## Architecture — one writer behind the seam

```
page (HTTP routes)  ─┐
                     ├─►  server.mjs + lib/core.mjs  ─►  data/state.json
assistants (MCP) ────┘        the one writer
```

- `server.mjs` — the web server and the ONLY process that touches state.
  `/api/tool` is the assistant seam; `/api/capture`, `/api/check`,
  `/api/undo` are the page's.
- `mcp-server.mjs` — a thin stdio adapter: MCP in, loopback HTTP out. Holds
  no state. Requires the server running.
- `lib/blocks.mjs` — the six block types, each fully defined in one table
  entry (make / update / project / schema fragment).
- `lib/tools.mjs` — the eight `december_*` tools + dispatch.
- `lib/settle.mjs` — the settle pass: debounce, the run, and an honest
  `status()` (failures surface on the page as "didn't settle · retry").
  Its toolset deliberately excludes `december_undo` and `december_capture`:
  the engine organizes; it never reverts the page or writes captures.
- `lib/core.mjs` — state in memory, persisted per mutation. A new agent
  write burst (>60s gap) opens the one-level undo snapshot, uniformly for
  the settle pass and connected assistants. Manual page writes never do.

`data/` is runtime state (gitignored). Delete `data/state.json` to reset.
Model via `DECEMBER_MODEL` (default `claude-sonnet-5`).

## Design

Per the Design repo §1.12 quiet-board register: tokens verbatim, no eyebrow
text, tabular numbers, ink/bone dark mode (toggle top right), and the commit
celebration on completions. The page is the input — no text box, just the
caret. Type anywhere; focus finds the field. A text-only rail of spaces
appears at three or more.

## Not built yet

Multi-user + auth, sync/hosting (single local JSON file), notifications for
reminders, editing block content by hand (talk to the page instead), and
richer undo (per-batch history).
