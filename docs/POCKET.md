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

## Desktop settings

Pocket is available from the desktop app's Settings panel. The section uses plain connection states instead of exposing protocol details:

- **Connect phone** requests a one-time pairing URL and opens a locally rendered QR code.
- A connected phone shows the last successful sync, or says that it is ready for its first sync.
- A pending revision or unreachable relay is reported as waiting or offline. Local writes remain available and the background retry continues.
- **Sync now** uploads the current page and pulls phone captures. The status reports how many phone notes were added.
- **Disconnect** requires confirmation, removes the local pairing, and returns the section to its disconnected state.

The status region announces changes to screen readers. The pairing view is a labelled modal dialog with Escape, close-button, focus-return, and focus-trap behavior. Its actions are native buttons and the compact layout wraps at 390px without horizontal overflow.

## Pairing privacy boundary

The pairing URL is a secret. Its fragment contains the Pocket credential and content key. The desktop UI applies these constraints:

- `public/js/qr-code.js` creates the QR symbol in the browser. It has no CDN, image service, tracking request, or runtime dependency.
- The URL moves only from the local pair response into short-lived UI memory and the generated SVG. It is not written to storage, inserted as text or HTML, logged, or sent to a QR provider.
- The pair response is split immediately. `pairingUrl` is excluded before the remaining safe fields become status state.
- Closing the pairing dialog clears both the in-memory URL and all QR DOM children. This also happens when Settings closes, Escape or the close button is used, the page hides, disconnect is confirmed, QR generation fails, or a stale pair request completes after the view has closed.
- Status and errors render with fixed, nontechnical copy through `textContent`. Relay error text and credentials are never rendered into HTML.
- `GET /api/pocket`, sync, and disconnect responses contain status only. The pairing URL appears only in the successful pair response.

Disconnect currently forgets the pairing on this computer. It does not revoke the already issued remote credential; remote revocation remains a protocol follow-up.

## User flow

1. Open December on the computer, select Settings, and choose **Connect phone** under Pocket.
2. Open December Pocket on the phone and scan the QR code.
3. Close the pairing view. December removes the sensitive URL and QR immediately.
4. Continue writing on either device. Desktop writes remain local-first and sync retries in the background when the relay is unavailable.
5. Use **Sync now** when an immediate upload and phone-capture pull is needed.
6. To remove the phone from this computer, choose **Disconnect**, then **Yes, disconnect**.

## Live acceptance checklist

Run this checklist against the packaged desktop app and the production relay. The operator retains the final acceptance decision.

- [ ] Open Settings while unpaired. Pocket says the phone is not connected and offers **Connect phone**.
- [ ] Use only the keyboard to open Settings, start pairing, cycle focus inside the pairing dialog, close it with Escape, and confirm focus returns to the initiating control.
- [ ] Start pairing again. Confirm that the QR scans from the phone and that browser/network logs show no external QR, image, analytics, or tracking request.
- [ ] Inspect the pairing view after closing it. Confirm that the QR container is empty and no URL fragment, Pocket token, or content key remains in the DOM or application logs.
- [ ] At a 390px viewport, open Settings and pairing. Confirm there is no horizontal overflow and every action remains visible and usable.
- [ ] Complete pairing. Confirm Settings changes to the connected state and offers **Sync now** and **Disconnect**.
- [ ] Add a phone note and select **Sync now**. Confirm the note appears once on the desktop and the status reports the import and successful sync.
- [ ] Make a desktop change while the relay is unreachable. Confirm the write succeeds locally, Pocket reports waiting/offline without raw error text, and sync succeeds after connectivity returns.
- [ ] Start disconnect, select **Cancel**, and confirm the phone remains connected. Then confirm disconnect and verify the desktop returns to **Connect phone**.
