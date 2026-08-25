# December Pocket integration

December encrypts Pocket page and capture contents between your paired
devices; the relay stores opaque ciphertext.

That sentence is the whole claim, and it is deliberately narrow. It is not a
claim that December is zero-knowledge, and it is not a claim that everything
December keeps on your computer is encrypted — your page lives in
`data/state.json` in the clear, as it always has. What Pocket adds is a
second device, and the only thing this document is promising is that the
relay in between the two cannot read what passes through it.

The desktop process remains December's sole page writer. Pocket sync is an
observer of completed atomic writes:

1. A local mutation is persisted to `state.json`.
2. The persistence observer encrypts the current projected page and durably
   records a pending relay revision in `data/pocket.json`.
3. Relay upload runs in the background and retries from the durable pending
   revision after restart.
4. The desktop polls encrypted capture envelopes, decrypts them locally, and
   inserts each with a deterministic ID before acknowledging the relay cursor.

## Protocol v2

The envelope the phone and the desktop share is version 2. Version 1 is not
read: an envelope arriving today that claims version 1 is a downgrade
attempt, not a leftover, and is refused.

**Keys.** Pairing mints one 32-byte root content key on the desktop. It never
reaches the relay. Every working key is derived from it with HKDF-SHA256 over
a domain-separated info string:

```
december.pocket.v2|<purpose>|<spaceId>|<epoch>
```

`purpose` is `page` or `capture`. Page keys and capture keys are therefore
distinct, and a key for one space or epoch is useless in another.

**Associated data.** Each AES-256-GCM envelope binds, as AEAD associated
data, the protocol version, the purpose, the space, the epoch, and the
position — the page revision for pages, the capture ID for captures. A
message cannot be replayed as a different kind of message, into a different
space, under a different epoch, or at a different position.

**Epochs and rollback.** The space carries a key epoch. Rotation increments
it and mints a fresh root key. The desktop accepts only envelopes whose epoch
equals the current one: an older epoch is rejected as a rollback, a newer one
as unknown. The capture cursor moves in one direction, so a relay handing
back an already-acknowledged sequence is refused as a replay rather than
imported twice.

**Cipher.** AES-256-GCM throughout, with a fresh 96-bit IV per envelope.

## Pairing claims

A pairing code is a claim, not a credential. The relay issues it with:

- a single-use flag, which the desktop requires,
- an expiry no more than five minutes out, which the desktop requires,
- an identifier and a secret, delivered together only in the pairing URL.

The desktop refuses a relay that offers a reusable claim, a claim with no
expiry, an already-expired claim, or one that lives longer than five minutes.
No claim field or presentation expiry is written to `data/pocket.json`. The
claim exists only in the pairing URL held by the open pairing surface.

The desktop's own credential is device-specific. It sends a `deviceId` with
the pair request and refuses a response issued to any other device. Every
authenticated request carries the space, the device, and the epoch alongside
the bearer token.

Pairing URL fragment (the cross-repo contract with the phone client):

```
https://<relay>/#v=2&space=<spaceId>&epoch=<n>&claim=<id>.<secret>&key=<base64url>
```

### Manual pairing capsule

The manual code carries an independent 128-bit selector and 128-bit secret.
Its canonical form is `D2<26 selector characters><26 secret characters>` in
Crockford Base32. ASCII spaces and hyphens may separate characters for
display. No other character is ignored; `I`, `L`, `O`, `U`, and encodings
with non-zero Base32 pad bits are refused.

The encrypted plaintext contains exactly these fields, in this order:

```json
{
  "v": 1,
  "protocolVersion": 2,
  "spaceId": "<space ID>",
  "claimId": "<claim ID>",
  "claimSecret": "<claim secret>",
  "rootKey": "<base64url root key>"
}
```

The selector sent to the relay is the canonical unpadded base64url encoding
of the 16 selector bytes. The 16-byte manual secret is the HKDF-SHA-256 input.
The salt is `december-relay/2|manual-capsule|salt|<selector>` and the info is
`december-relay/2|manual-capsule|key|1`. Associated data is
`december-relay/2|manual-capsule|aad|1|<selector>`. All three domain strings
are UTF-8, and HKDF produces a 32-byte AES-256-GCM key.

Ciphertext is unpadded base64url of a 12-byte nonce followed by the sealed
JSON and its 16-byte GCM tag. December sends an authenticated
`POST /pair/capsules` with exactly:

```json
{
  "selector": "<base64url 128-bit selector>",
  "ciphertext": "<opaque base64url capsule envelope>"
}
```

The relay owns the exact five-minute expiry from upload. A phone fetches with
`POST /pair/capsules/fetch` and a body containing exactly `selector`. Neither
request contains the manual secret. Re-fetching a capsule cannot replay the
underlying pairing claim because that claim remains single-use.

## Where the secrets rest

`data/pocket.json` holds the desktop credential, the device identity, and the
content key. In the desktop app these values are sealed before they touch the
disk:

| Situation | Backend | Behaviour |
|---|---|---|
| Windows, macOS, Linux with a working keyring | `os` | Electron's `safeStorage` wraps one long-lived key in `pocket-master.key` under the app's user-data directory. That key seals the Pocket secrets. |
| December run as a plain server, no desktop shell | `file` | The historical behaviour, labelled honestly: a `0600` file, unsealed. |
| Linux reporting `basic_text` or `unknown`, or a keychain that fails | `basic_text` | **No Pocket secrets are written at all.** Any that are found are removed. |

`basic_text` is Chromium obfuscating with a hardcoded key. December treats it
as no key store rather than as protection, and fails safe: Pocket will not
pair and will not persist, and the rest of December is untouched and fully
usable. The desktop shell unwraps the key once at startup and hands it to the
local server in that child process's environment; it is never written
anywhere else.

A file sealed under the key store will not open with plain secrets someone
substituted, and vice versa. A run that cannot open its own secrets reports
the problem and rewrites nothing, so a transient keychain failure never
destroys a working pairing.

**Migration.** A version 1 `pocket.json` — plaintext credentials and content
key — is rewritten sealed in a single atomic write (temporary file, then
rename). Because the phone on the other end still holds a version 1 key, the
migrated pairing is marked as needing repair: it uploads nothing and imports
nothing until **Reconnect phone** rotates it onto protocol v2. On a computer
with no key store, migration removes the plaintext secrets outright.

## Local API

- `GET /api/pocket` — safe connection and sync status; never returns
  credentials.
- `GET /api/pocket/capability` — the per-run capability the acting routes
  require.
- `POST /api/pocket/pair` — create a relay space, publish the current page,
  and return one short-lived presentation: QR URL, manual code, and expiry.
- `POST /api/pocket/reconnect` — repair a phone by immediately revoking phone
  credentials, deleting old ciphertext, opening the next epoch, and returning
  a fresh presentation.
- `POST /api/pocket/lost` — immediately perform the same safe rotation for a
  lost or stolen phone.
- `POST /api/pocket/rotate` — compatibility route for older local pages;
  dispatches `protocol-repair`, `move-device`, and `lost-phone` to their
  atomic rotation lifecycle.
- `POST /api/pocket/sync` — force a page upload and capture pull.
- `POST /api/pocket/disconnect` (and `POST /api/pocket/revoke`) — ask the
  relay to delete the space and everything in it, then forget the pairing
  here.

The configured relay is `DECEMBER_RELAY_URL`, defaulting to
`https://app.getdecember.me`. Non-HTTPS relay URLs are accepted only for
localhost development. The relay endpoints the desktop expects are `/pair`,
`/pair/capsules`, `/rotate`, `/revoke`, `/page`, `/captures`, and
`/captures/ack`. `/rotate` atomically advances the epoch, revokes active phone
credentials, deletes ciphertext sealed under the old key, and issues a fresh
one-time claim. A retry at the new epoch returns a fresh claim without rotating
or deleting twice.

## Loopback hardening

December's local server is reachable by anything else running on the same
computer, so every request passes the same gate before any route sees it:

- **Host** must be a loopback name on December's own port. A missing Host
  fails closed. This closes DNS rebinding.
- **`Sec-Fetch-Site`**, when present, must be `same-origin` or `none`. A
  browser stamps it on every request, so a cross-site page is refused whether
  or not it sends an Origin. Clients that are not browsers — the MCP adapter,
  the desktop shell, curl — send no such header and are yours.
- **Origin**, on writes, must be local.
- **Capability**, on every acting Pocket route. Any page can post to a
  loopback port, but only a page December served can *read* a reply, so the
  value handed out by `/api/pocket/capability` is one a hostile tab cannot
  hold. It is minted per run and never written to disk. Plain status stays
  open; it holds nothing worth stealing.

Every response carries `nosniff`, `no-referrer`, `same-origin` COOP and CORP,
a closed `Permissions-Policy`, and `X-Frame-Options: DENY`. The page is
served with a Content Security Policy of `default-src 'none'` plus exactly
what it uses. Inline scripts are permitted by SHA-256 hash computed from the
file at serve time, so December's own theme guard runs and an injected inline
script does not. There is no `unsafe-inline` or `unsafe-eval` in `script-src`.

## Desktop window

The Electron window is pinned to December's own loopback origin:

- `will-navigate` and `will-redirect` refuse anything else; a plain `https:`
  target opens in the real browser instead, where the address bar is visible.
- `setWindowOpenHandler` denies every new window.
- `will-attach-webview` is refused, and `webviewTag` is off.
- All permission requests and checks are denied.
- The renderer runs sandboxed, context-isolated, with no Node integration in
  the page, workers, or subframes.

## Desktop settings

Pocket is available from the desktop app's Settings panel. The section uses
plain connection states instead of exposing protocol details:

- **Connect phone** requests a one-time pairing presentation and opens a
  locally rendered QR code plus a manual code.
- **Reconnect phone** repairs protocol or connection trouble. It confirms the
  action, immediately rotates the epoch, and returns a fresh presentation.
- **Move to a new phone** confirms that the old phone will be disconnected,
  then atomically rotates the epoch and returns a fresh presentation for the
  installed Pocket app on the new phone.
- **Phone lost or stolen** confirms the destructive action and immediately
  revokes phone access before showing a fresh presentation.
- A connected phone shows the last successful sync, or says that it is ready
  for its first sync.
- A pending revision or unreachable relay is reported as waiting or offline.
  Local writes remain available and the background retry continues.
- **Sync now** uploads the current page and pulls phone captures. The status
  reports how many phone notes were added.
- **Disconnect** requires confirmation. It asks the relay to delete the space
  before forgetting the pairing here. If the relay cannot be reached, the
  pairing is gone from this computer regardless and December keeps only the
  revocation request, retrying it on the next sync.
- A computer with no key store says so plainly and offers nothing to connect.

The status region announces changes to screen readers. The pairing view is a
labelled modal dialog with Escape, close-button, focus-return, and focus-trap
behavior. Its actions are native buttons and the compact layout wraps at 390px
without horizontal overflow.

## Pairing privacy boundary

The pairing URL is a secret. Its fragment contains the pairing claim and the
content key. The desktop UI applies these constraints:

- `public/js/qr-code.js` creates the QR symbol in the browser. It has no CDN,
  image service, tracking request, or runtime dependency.
- The URL and manual code move only from the local pair response into
  short-lived UI memory; the URL also enters the generated SVG. Neither is
  written to storage, inserted as HTML, logged, or sent to a QR provider.
- The pair response is split immediately. `pairingUrl`, `pairingCode`, and
  `pairingExpiresAt` are excluded before the remaining safe fields become
  status state. `GET /api/pocket` never returns them.
- Closing the pairing dialog clears the in-memory URL, manual code, expiry,
  timer, and all QR DOM children. This also happens when Settings closes,
  Escape or the close button is used, the page hides, disconnect is confirmed,
  QR generation fails, or a stale pairing request completes after the view has
  closed.
- Status and errors render with fixed, nontechnical copy through
  `textContent`. Relay error text and credentials are never rendered into HTML.
- `GET /api/pocket`, sync, and disconnect responses contain status only. The
  pairing URL appears only in a successful pair or rotate response.

## What this does not cover

- Independent security review. Nothing here has had one.
- Relay-side quotas, transport security headers, and stored-ciphertext
  garbage collection. Those live with the relay.
- Your local page. `data/state.json` is not encrypted.

## User flow

1. Open December on the computer, select Settings, and choose **Connect
   phone** under Pocket.
2. On the phone, open [app.getdecember.me](https://app.getdecember.me) and
   scan the QR code or enter the manual code within five minutes. The
   underlying claim works once.
3. Close the pairing view. December removes the sensitive URL, manual code,
   expiry, and QR immediately.
4. Continue writing on either device. Desktop writes remain local-first and
   sync retries in the background when the relay is unavailable.
5. Use **Sync now** when an immediate upload and phone-capture pull is needed.
6. For protocol trouble choose **Reconnect phone**. To replace a phone, install
   Pocket on the new phone first, then choose **Move to a new phone**. Creating
   the new code revokes the old phone immediately. If the phone is gone, choose
   **Phone lost or stolen**.
7. To remove Pocket from this computer entirely, choose **Disconnect**, then
   **Yes, disconnect**.

## Live acceptance checklist

Run this checklist against the packaged desktop app and the production relay.
The operator retains the final acceptance decision.

- [ ] Open Settings while unpaired. Pocket says the phone is not connected and
      offers **Connect phone**.
- [ ] Use only the keyboard to open Settings, start pairing, cycle focus
      inside the pairing dialog, close it with Escape, and confirm focus
      returns to the initiating control.
- [ ] Start pairing again. Confirm that the QR scans from the phone and that
      browser/network logs show no external QR, image, analytics, or tracking
      request.
- [ ] Inspect the pairing view after closing it. Confirm that the QR container
      is empty and no URL fragment, claim, or content key remains in the DOM
      or application logs.
- [ ] At a 390px viewport, open Settings and pairing. Confirm there is no
      horizontal overflow and every action remains visible and usable.
- [ ] Complete pairing. Confirm Settings changes to the connected state and
      offers **Sync now**, **Reconnect phone**, **Move to a new phone**,
      **Phone lost or stolen**, and **Disconnect**.
- [ ] Leave a pairing code unscanned for six minutes. Confirm the relay
      refuses it and the desktop offers a fresh one.
- [ ] Scan one pairing code from two phones. Confirm the second is refused.
- [ ] Add a phone note and select **Sync now**. Confirm the note appears once
      on the desktop and the status reports the import and successful sync.
- [ ] Make a desktop change while the relay is unreachable. Confirm the write
      succeeds locally, Pocket reports waiting/offline without raw error text,
      and sync succeeds after connectivity returns.
- [ ] Choose **Reconnect phone**. Confirm the old phone can no longer read the
      page or send captures, and that a capture it queued before the rotation
      is refused rather than imported.
- [ ] Install Pocket on the replacement phone, then choose **Move to a new
      phone**. Confirm the old phone is revoked before the fresh QR appears,
      and the new phone loads the current page after pairing.
- [ ] Interrupt the first rotation response and retry. Confirm the relay keeps
      the same epoch, invalidates the unseen claim, and returns one usable
      replacement claim without deleting twice.
- [ ] Inspect `data/pocket.json` on Windows and macOS. Confirm no credential
      or content key appears in the clear.
- [ ] Run the desktop app on a Linux session with no keyring. Confirm December
      opens and works, Pocket says it is unavailable, and no Pocket secret is
      written to disk.
- [ ] Upgrade over an existing version 1 pairing. Confirm `pocket.json` is
      rewritten sealed, Pocket asks for a reconnection, and nothing is
      uploaded until **Reconnect phone** completes.
- [ ] Start disconnect, select **Cancel**, and confirm the phone remains
      connected. Then confirm disconnect, verify the desktop returns to
      **Connect phone**, and verify from the phone that the relay space is
      gone.
- [ ] Disconnect while the relay is unreachable. Confirm the pairing is gone
      locally, the status says the delete is still pending, and the delete
      completes on a later sync.
