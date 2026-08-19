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

You did not choose a type, name a card, or pick a chart. You did not learn
anything. It was built for people who do not have an assistant, which is
almost everyone.

The frame is a year, and the name is the argument. January is when people
measure themselves and decide they do not measure up. The resolution gets made
there, and it is mostly a statement about who someone would like to be.
December is where the weigh-in actually happens, and what you did across the
year counts for more than what you decided at the start of it. So the page is
built around getting you there, with something to show.

There is a second reason to keep a record like this one, and it is where the
whole thing is pointed.

The usual word is agent, and most people do not respond to it. The better word
is digital worker: something that does the kind of work a person does at a
screen, without a person having to sit there and do it. A digital worker needs
somewhere to look. Not a conversation, which ends. Not a project tool, which
someone has to keep fed. It needs a standing record of what is true and what
is unfinished, kept current without anyone maintaining it.

That is what this is. In time, what you write here is what gets picked up. You
put the line down, and the work gets done without you having to ask twice.

None of that part is built. The record comes first, because nothing can be
done on your behalf until one place is written down and correct. The seam it
would work through already exists, and it is the same one you can use today.

The front of this was made in a few days. The systems that made building it in
a few days possible took two years, and most of the distance was covered in
the last six months.

It is open source and it is public. No account, no server, no company standing
between you and the page. Clone it, read all of it, change what you want, keep
what you make. It was built to be used. Created by
[louie305](https://github.com/louie305).

---

## Running it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/Patchnet/december-app.git
cd december-app
node server.mjs                 # → http://localhost:3008
```

No install, no build, no dependencies.

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
npm install && npm run app        # run the shell in place
npm run dist:win                  # build the Windows installer (unsigned yet)
```

First run shows the connection cards — choose a signed-in CLI and the page
organizes itself from then on; skip it and December waits, capture-only,
until you connect one.

## Tests

The suite runs on Node alone — no test dependencies:

```bash
node --test
```
