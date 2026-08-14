# December Pocket integration

The desktop process remains December's sole page writer. Pocket sync is an observer of completed atomic writes:

1. A local mutation is persisted to `state.json`.
2. The persistence observer encrypts the current projected page and durably records a pending relay revision in `data/pocket.json`.
3. Relay upload runs in the background and retries from the durable pending revision after restart.
4. The desktop polls encrypted capture envelopes, decrypts them locally, and inserts each with a deterministic ID before acknowledging the relay cursor.

The relay never receives the content key. `data/pocket.json` is local-only and contains the desktop credential, pocket credential, and content key needed to recreate the pairing link.

## Local API

- `GET /api/pocket` — safe connection and sync status; never returns credentials.
- `POST /api/pocket/pair` — create a relay space, publish the current page, and return a one-time pairing URL for the desktop UI to render as a QR code.
- `POST /api/pocket/sync` — force a page upload and capture pull.
- `POST /api/pocket/disconnect` — forget the local pairing. Remote revocation is a later protocol addition.

The configured relay is `DECEMBER_RELAY_URL`, defaulting to `https://app.getdecember.me`. Non-HTTPS relay URLs are accepted only for localhost development.

## Remaining UI seam

The settings page should call the local API, render the returned pairing URL as a QR code, show `lastSyncedAt` and `lastError`, and expose sync/disconnect actions. Keep the full pairing URL out of logs and remove it from the DOM when the dialog closes.
