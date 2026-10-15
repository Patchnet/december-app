# Agent board mode

A coding agent keeps its own tasks on a December board, and the person watches.
Nobody picks the mode: when December's MCP connection starts inside a git repo,
that repo gets its own board. Anywhere else the connection gets the person's page,
unchanged.

## How it works

1. At `initialize`, `mcp-server.mjs` runs `git rev-parse --show-toplevel` in its
   working directory (`lib/board-mode.mjs`). A git root means board mode, keyed by
   that root. `DECEMBER_MODE=page|board` overrides it. December's own organizer
   always gets the page.
2. `lib/board-host.mjs` keeps each board in its own store at
   `…/December/boards/<repo>-<hash>/` (`board.json`, `server.json`, `state.json`).
   It reuses the board's server if one answers, or starts a detached `server.mjs`
   with `DECEMBER_MODE=board` on the first free port from 3031.
3. The handshake instructions lead with the board URL and tell the agent to open it
   in its browser now, followed by the board manners.
4. On a board, the organizer, Pocket, the watch and the journal stay off. What the
   person types stays in the inbox as a note to the agent, and `december_view`
   shows it.

Environment variables: `DECEMBER_BOARDS_DIR` sets the boards folder, and
`DECEMBER_MODE` forces a mode.

## Mirror Claude Code's todo list (optional)

`scripts/board-hook.mjs` is a PostToolUse hook. It mirrors `TodoWrite` (and
`TaskCreate`/`TaskUpdate`) onto one card, "Session plan". It never starts a board,
and it exits silently when there isn't one. To use it, add this to
`~/.claude/settings.json` or the repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "TodoWrite|TaskCreate|TaskUpdate",
        "hooks": [{ "type": "command", "command": "node /path/to/december/scripts/board-hook.mjs" }]
      }
    ]
  }
}
```

If you set `DECEMBER_BOARDS_DIR` for the MCP server, give the hook the same value.

## Demo

```bash
node scripts/board-demo.mjs
```

The demo creates a scratch repo, connects to it as `claude-code` over real MCP
stdio, and plays a short session on the board. The board server stays running
afterwards.
