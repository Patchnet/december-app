<p align="center"><img src="docs/assets/icon.png" width="96" alt="December" /></p>

# December

> "The computer is the most remarkable tool that we've ever come up with. It's
> the equivalent of a bicycle for our minds."
>
> — Steve Jobs

For five years the industry has been building the frontier. Bigger models,
better reasoning, more of what is possible. That work is real and it is not
finished. But almost none of it has been pointed at the ordinary, unglamorous
business of keeping a life in order. That is the next part, and it is the part
worth doing. It starts small.

Most people are not disorganized. They are carrying too much.

The rent. A shift on Thursday. The miles you meant to run. An appointment you
will have forgotten by Friday. None of it is difficult on its own. Together it
is a second job, and it is worked in your head, at night, for free.

Every tool built to hold this asks you to do that job first. Pick a project,
name a list, choose a template, decide where the thing belongs before you are
allowed to write it down.

December asks for a sentence.

You write one line, the way you would say it out loud. It is saved the moment
you type it. Then it is put where it belongs.

```
you write

  paid rent 2300 and ran 4 miles before work

and a moment later

  Rent                        Running
  8 of 12 payments            412 of 600 miles
  ● ● ● ● ● ● ● ● ○ ○ ○ ○     ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔░░░░░░
  $18,400 paid                ran today · 118 days
```

You did not pick a card type or set up a chart. There is nothing to learn.

December goes against the current AI trend. Everything is a chat now, and
what you said last week is buried in a thread. December does the opposite. It
puts what is important in front of you when you need it, and it keeps track
of the rest.

The intelligence is your own AI, running on your own computer. If you already
use Claude Code or Codex, December works with that. No new subscription, no
API keys, no cost per line. Any assistant you use can also connect to the
page over MCP and read or update it. It is an app for getting organized and
staying on top of what you want to get done, and not just for you, but for
you and your AI.

The page covers one year. The point is to get to December with a record of
what you actually did, the goals you reached, and the milestones along the
way.

We built this for ourselves first, to get on top of the disorder that comes
with fast AI content generation. We are working on more features and
improvements.

Use as you wish, drop us a note on how we can make it better. [Apache 2.0](LICENSE) licensed.
December, the name and the marks, belong to [louie305](https://github.com/louie305). The license is for the software, not the trademarks. See [TRADEMARKS](TRADEMARKS.md).

---

## Running it

You need [Node.js](https://nodejs.org) 22.13 or newer.

```bash
git clone https://github.com/Patchnet/december-app.git
cd december-app
node server.mjs                 # → http://localhost:3008
```

No install, no build, and no runtime dependencies.

The intelligence is your own. December uses a CLI you are already signed into,
[Claude Code](https://claude.com/claude-code) or
[Codex](https://developers.openai.com/codex/cli/), rather than an API key, so
organizing costs nothing per line. It also means it needs one. Without it,
everything you write is still saved and the page says so plainly. It waits to
be sorted. Writing is never blocked.

## Your data

Files on your machine. Nothing is uploaded. There is no account.

```
data/state.json            the page
data/events-<year>.jsonl   every change, in order
data/years/<year>.json     past years, kept whole
data/backups/              a snapshot a day, thirty kept
```

Writes are atomic, so an interrupted one cannot leave a torn file. If the page
is ever unreadable, December restores the newest good copy and says so. If
nothing anywhere can be read it refuses to start rather than show an empty
page over a full one.

Delete `data/` to begin again.

## Under it

One process owns the state and everything else asks it, so nothing writes
behind anything else's back. There are six block types, each with one designed
way of looking that the model cannot override. The model decides what a
sentence means. The app decides how it appears.

The same surface is exposed over MCP, so an assistant you already use can read
and write the page directly. That is the seam a digital worker would work
through.

Connect yours in one step — start December, then:

```bash
node connect.mjs
```

It finds Claude Code, Claude Desktop, Codex, and Cursor, connects the ones
you choose (`--yes` takes them all), publishes December's small
house-manners skill beside them, and checks the result. Prefer clicking?
The gear's **Connections** cards do the same, and they are part of first-run
setup in the desktop app. ChatGPT appears honestly as not-yet-connectable —
a local-only server has nothing it can reach; that arrives with sync.

The server must be running while an assistant works. The desktop app owns
`http://localhost:3008` (falling back to `:3009`); `DECEMBER_URL` pins a
connection anywhere else.

## The desktop app

The same page, resident: a tray icon that keeps December running, a window
over the local server, and `Ctrl+Alt+D` from anywhere to capture. Closing the
window hides it; Quit lives in the tray. Desktop state keeps to your user
profile, so the repo stays clean and reinstalls never touch your year.

```bash
npm ci && npm run app             # install development tools; run the shell in place
npm run dist:win                  # build the Windows installer (unsigned yet)
```

First run separates two jobs. Choose an installed, signed-in Claude Code or
Codex CLI as the organizing engine. Assistant connections are optional: they
let Claude Code, Claude Desktop, Codex, or Cursor read and update the page,
but they do not organize captures. Without an available engine, December
waits in capture-only mode and keeps every line safe.

## Tests

Install the development dependencies, then run the mandatory lint and Node test gates:

```bash
npm ci
npm test
```

The application itself still has no runtime dependencies. ESLint, Electron,
and the packaging tools are development dependencies only. `npm run lint`
runs the scope-aware undefined-name and unused-name check; `npm run test:node`
runs only the built-in Node test suite and is not the complete gate.
