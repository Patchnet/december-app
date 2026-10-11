# December agent runtime

December keeps one local server as the state owner. The browser, Pocket and MCP clients use the same core mutations. This refinement preserves the workspace presentation while removing Jev execution and shortening the path between a saved capture and its visible result.

## Capture and engine work

Captures are saved before organization. The scheduler coalesces arrivals for 150 ms, bounded by 500 ms from the first arrival. It runs one engine job at a time, with FIFO foreground work ahead of journal and surfacing jobs. A foreground job aborts disposable background inference; that background job remains queued and restarts from fresh inputs. Up to 16 jobs may wait. Superseded questions are aborted from the browser through the HTTP request to the CLI subprocess.

Each organizing pass owns a fixed batch of up to eight capture IDs. New arrivals belong to another pass, and ordinary external MCP clients retain their full-page view. A failed pass leaves its remaining captures saved for retry rather than repeatedly invoking an engine. Successful passes drain subsequent batches. Claude retains its existing persistent process with 20-turn rotation and a five-minute idle retirement. Codex retains its one-shot CLI adapter. Shutdown aborts queued and active engine work.

The internal MCP connection carries a per-server session token. Invalid tokens fail rather than becoming external access. This separates internal batch semantics from other local clients; it is not a defense against arbitrary software running as the same operating-system user.

## Context and answers

The organizer gets a catalog of space and block identities, types, short summaries and content versions. Explicit names and capture hints rank first. Catalog pages fit a 48 KB record budget and expose continuation metadata. Oversized spaces remain discoverable through a separate paged block catalog. Full block reads remain available before changes. Standing lessons, About Me and the assigned captures are retained outside the catalog budget, so 48 KB is not an absolute total-prompt limit.

Questions retrieve complete local records, including old ledger entries and note text beyond the organizer summary. Records are paged as complete JSON values; long notes carry chunk offsets. Ledger aggregates use all matching entries and exact decimal addition for amounts representable at two decimal places. Optional inclusive local-date bounds support historical totals. Unsupported precision returns a null aggregate rather than silently rounding. The narrow phrases “What is the total for NAME?” and “What is the open task count in NAME?” can answer locally without an engine. Other questions use the configured engine and a read-only December MCP connection. That connection advertises and enforces only view, block read, space read and query tools; user-configured native agent permissions are unchanged.

Successful model answers have a bounded 64-entry process-local cache keyed by question, page revision, minute and engine configuration. Failures are not cached. A page change while an answer is running rejects the stale answer. Generated journal/surfacing results are checked against current input state before saving; preempted work restarts and manually invalidated work is rescheduled.

## Writes, replay and recovery

Internal existing-block writes must present the latest content version. Goal moves check both source and destination. A conflict returns HTTP 409 and VERSION_CONFLICT; reread that target and continue remaining work. Mutations with a supplied version return the version captured at mutation time. Replay is checked before preconditions so a lost response can return its original receipt without applying the write again. Legacy external clients retain optional preconditions and existing identity-free semantics.

Stable operation identities and undo remain in place, including old `jev-*` identities. No provider is needed to replay these receipts. The 10,000-global-receipt stop has been removed; the per-capture 64-operation bound remains and leaves an oversized capture recoverable for explicit handling.

After an organizing pass, more than 8,000 active receipts can trigger compaction toward 4,000. Pending captures and the current undo group are excluded. Eligible receipts are copied in full to `operation-archive.json` by atomic replacement **before** they leave `state.json`. A crash between those writes leaves duplicate receipts, which are safe: the active-state receipt wins. Both stores participate in indexed replay lookup. No time-based receipt deletion is performed. A required missing or malformed archive fails startup rather than risking duplicate operations. The archive remains an in-memory index at runtime; this is snapshot-size management, not unlimited-memory storage.

Back up `state.json` and `operation-archive.json` together. Automatic backups copy the archive alongside the daily snapshots. When restoring a state snapshot, retain the newest intact receipt archive; newer receipts help prevent replay of already performed operations. Downgrading to a build that predates receipt archives requires offline reintegration of archived receipts into `state.operations` first. Do not run that older build directly against compacted data. A database migration and a new multi-command transaction format are intentionally outside this release.

With the app stopped, `node scripts/restore-operation-receipts.mjs STATE ARCHIVE NEW_OUTPUT` prepares a new state file for that downgrade without overwriting either input. Keep both original files as backups, then install the prepared state file. The older build's original 10,000-receipt limit still applies; reintegration preserves safety, not that older build's ability to add more receipts.

Atomic state-file replacement retains the existing process-crash protection. This change does not add or claim an fsync-based power-loss guarantee. Captures are never acknowledged through a delayed persistence debounce.

## Delivery and ordering

Server-sent change events are independent of providers and carry revision/status identity, not page text. Clients retain coalesced refresh and polling recovery. Slow/disconnected streams are closed. Capture paint diagnostics use bounded filed-capture identities rather than relying only on the last six activity rows. Queue, engine, tool and persistence durations remain bounded and local; no private capture text or credentials enter timing metrics.

Unpaired Pocket instances no longer project a full page after every mutation. Paired Pocket retains its existing coalesced upload contract. Card ordering keeps urgency, pin and activity precedence and uses one clock per projection. Search ranks the full candidate index before selecting eight results and preserves distinct item identities. Attention rows retain separate same-text reminders; their seven-day horizon uses local calendar arithmetic.

## Jev and the visual boundary

Provider modules, routing, credentials, setup scripts and model-specific tests are removed. Old Jev environment variables have no execution effect. `npm run preview:simulate` creates a fresh temporary synthetic page and disables model calls. It never selects the person's existing data directory.

The existing disabled Settings diagnostic section remains visually unchanged through an inert status object. It is compatibility presentation, not an available integration. The pure legacy capture-action adapter remains for receipt/recovery compatibility tests. CSS, markup, artwork, typography, cards and motion implementation are unchanged by the runtime refinement. Search results and correctly distinct reminders can differ because their data behavior is fixed.

## Validation

Run `npm test` on Node 22.13 and 24. Set `DECEMBER_RELAY_ROOT` to the supported sibling Relay checkout for the real local contract fixture. New tests cover queue preemption and cancellation, fixed batch scope, multiple batches through a fake streaming CLI, generic push, read-only MCP enforcement, version conflicts, old receipt replay after compaction, context coverage, complete ledger retrieval and identity-based search.

The fixture CLI performs real HTTP/tool calls but no provider inference. Passing these tests does not establish real-model routing quality, inference latency, phone pairing, or installed Windows upgrade behavior. Those remain release validation requirements. No version tag or publication is part of this implementation.
