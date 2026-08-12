# December

**You write. It organizes itself.**

One page. You type a sentence at the top left — it lands instantly — and an
agent settles it behind you into cards. The frame is the year: what will you
have done by December?

```
you type ───────────────────────────────────────────────────────────

  paid rent this month 2300 and ran 4 miles before work

a few seconds later ────────────────────────────────────────────────

  Rent                        Running
  8 of 12 payments            412 of 600 miles
  ● ● ● ● ● ● ● ● ○ ○ ○ ○     ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔░░░░░░░
  Paid              $18,400   Ran today   ● ● ● ● ●   118
```

You never chose "tracker" or "ledger". You never made a card, named a space,
or picked a chart. You wrote a sentence the way you'd say it out loud.

December is a local-first page for the things you need out of your head and
somewhere you'll trust in November — rent, mileage, a habit, a dentist
appointment, a thought about a side project. Not a task manager, not a notes
app with folders. **A ledger of your year.**

---

## Why it's built this way

Most "AI-powered" apps hand the model a canvas and ask it to generate an
interface. The results look generated.

December splits the job:

> **The model picks the meaning. The app picks the presentation.**

The agent's only structural choice is which of **six block types** a sentence
belongs to — and each type has one designed way of looking, which the model
cannot override. A count toward a goal is always a tracker. Money is always a
ledger. That's why a sentence about rent becomes a rent tracker rather than a
row in a generic table, and why the page looks composed instead of assembled.

Six is deliberate: small enough that the model picks correctly almost every
time, expressive enough to hold a life.

| type | for | looks like |
|---|---|---|
| **list** | checkable things | rows you can tick |
| **tracker** | progress toward a number | a bar, or dots when the target is small |
| **ledger** | amounts that accumulate | a running total, grouped by month when opened |
| **streak** | a did-it-today habit | fourteen days on the card, the whole year when opened |
| **note** | kept prose | text, folded when long |
| **reminder** | a line that resurfaces until done | a date, and a place in your week |

---

## Getting started

**You need** [Node.js](https://nodejs.org) 20 or newer, and — for the
organizing — a CLI you're already signed into: [Claude
Code](https://claude.com/claude-code) or
[Codex](https://developers.openai.com/codex/cli/).

```bash
git clone https://github.com/Patchnet/december-app.git
cd december-app
node server.mjs                 # → http://localhost:3008
```

No install step, no build, no runtime dependencies. Just Node and the files
it serves.

**The intelligence is your own subscription, not an API key.** December
shells out to a CLI you have already signed into, and costs nothing extra per
capture. If neither is connected it still runs in **capture-only mode** —
everything you write is saved and the page says so plainly; it simply waits
to be organized until an engine is available. Writing is never blocked on a
model.

---

## What it does

**Write anything, in your own words.** Paste twenty lines at once and each
finds its own home. The page tells you when it is about to split something.

**It asks when it had to guess.** Write "lunch with my sister Friday" and it
files it *and* asks what time — one short question, answered by tapping or
typing. Your answer refines what it filed; it never blocks it.

**It faces the week.** Anything with a date appears under the writing line in
two bands: what is due today, and what is coming in the next seven days.
Click a line to jump to the card it came from, or tick it and be done.

**Every month is a place you can open.** Click the date for the year, then a
month to see what it actually held — grouped by space, in your own words,
with the shape of its weeks. That is the payoff: in November you look up and
find the year added up to something.

**Find anything.** `/` searches every card, item, note and entry. Ask a real
question — *"how much have I spent on the car?"* — and the page answers from
what it holds.

**Drop a document on it.** PDFs, images, `.docx`, spreadsheets, CSVs, plain
text. The agent reads the file and organizes its contents as your own words.

**Correct it once.** Tell it "groceries go under Food, not Housing" and it
remembers, permanently, for every future pass.

**Nothing accumulates into a mess.** Spaces untouched for a month rest below
the grid; close one out and it joins a finished list. All of it folds into a
single line of counts you can open, so the foot of the page never grows
however much year piles up.

**The year turns.** On January 1 the old year archives whole and stays
readable, and December walks you through every open thread one at a time:
keep it, or leave it with the old year. Nothing is deleted, and nothing is
forced.

---

## Connect your own assistant

December exposes its full tool surface over MCP, so any assistant you already
use can read and write the same page:

```bash
claude mcp add december -- node ~/december-app/mcp-server.mjs
```

Claude Desktop: add the same command under `mcpServers`.

Then ask it *"what's on my December?"* or *"log September's rent"* — it
reaches the same 22 `december_*` tools the app's own organizing pass uses.
There is no second interface and no privileged path: the settle agent is just
another client of the same seam.

---

## Your data

Everything is a file on your machine. Nothing is uploaded. There is no
account.

```
data/state.json            the page
data/events-<year>.jsonl   an append-only history of every change
data/years/<year>.json     past years, archived whole
data/backups/              a dated snapshot each day, thirty kept
```

**Writes are atomic.** The page is written beside itself and moved into place
in a single step, so an interrupted write cannot leave a torn file. If one is
ever unreadable anyway, December recovers from the newest good backup, keeps
the damaged file next to it, and says so — and if nothing anywhere can be
read it refuses to start rather than show an empty page over a full one.

Delete `data/` to reset completely. Export the year as Markdown any time from
the year view.

---

## Desktop app

The Electron shell wraps the same local server in a Windows desktop app: one
instance, a tray icon, and `Ctrl+Alt+D` from anywhere to focus the writing
line. Closing the window hides it; **Quit** from the tray stops December and
its server.

```bash
npm install
npm run app          # run it
npm run dist:win     # unsigned NSIS installer → release/
```

Desktop state lives in Electron's per-user data directory, passed through
`DECEMBER_DATA_DIR`. Standalone web mode uses this repo's `data/` unless that
variable is set.

---

## Architecture

```
    the page ──────┐                            ┌──► data/state.json
                   ├──►  server.mjs + core.mjs ─┤
    assistants ────┘         ONE WRITER         └──► data/events-<year>.jsonl
    (over MCP)
```

One process owns the state. Everything else — the page, the settle agent,
your own Claude — reaches it through the same HTTP interface, so nothing can
write behind anything else's back.

| file | what it is |
|---|---|
| `server.mjs` | the web server, and the only thing that touches state |
| `lib/core.mjs` | state in memory, persisted atomically per mutation |
| `lib/blocks.mjs` | the six block types, each defined in one table entry |
| `lib/tools.mjs` | the 22 `december_*` tools and their dispatch |
| `lib/settle.mjs` | the organizing pass, its debounce, and an honest `status()` |
| `mcp-server.mjs` | a thin stdio↔HTTP adapter. Holds no state |
| `public/` | the client. No framework, no build step |

**The settle pass** runs as a persistent Claude process holding one MCP
connection and a set of standing instructions — each settle is another turn
over `stream-json`, so there is no per-capture boot. Codex runs one-shot per
pass instead. Failures surface on the page as *"couldn't settle · retry"*
rather than leaving your words shimmering forever.

The organizing engine deliberately cannot call `december_undo` or
`december_capture`. It organizes what you wrote; it never reverts your page
or puts words in your mouth.

Choose the model with `DECEMBER_MODEL` (default `claude-sonnet-5`), or the
engine and its path from the gear.

---

## Development

```bash
node --test test/*.test.mjs
node data/mock-scale.mjs        # seed a full year to test at scale (server stopped)
```

`mock-scale.mjs` writes a synthetic 41-space, 616-moment year — the state the
page only bends under, and the fastest way to find out whether a change
survives contact with a real amount of content.

---

## Not built yet

Multi-user and auth, sync or hosting, hand-editing numeric fields (amounts
and tracker values stay agent-mediated), and richer undo than the current one
level.

---

Made by [Patchnet AI](https://patchnet.ai).
