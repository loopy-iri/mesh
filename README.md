# P2P Secure Mesh

A serverless-by-design mesh messenger PWA. Peers exchange signed messages over
WebRTC DataChannels, discover each other by gossip, and relay traffic
store-and-forward when no direct path exists. The only server is an ephemeral
signaling relay that sees SDP/ICE and nothing else.

```
PWA (identity + IndexedDB + gossip/router)
        |                     |
  DataChannel P2P     ephemeral signaling (offer/answer/ICE only)
```

## Layout

| Path | Role |
| --- | --- |
| `server/signaling.py` | Ephemeral relay: TTL mailboxes, long polling, static host |
| `server/test_signaling.py` | Relay unit + live HTTP tests |
| `web/index.html`, `web/styles.css` | Persian RTL UI shell |
| `web/src/crypto.js` | ECDSA P-256 identity, signing, `peerId` derivation |
| `web/src/db.js` | IndexedDB stores: `identity`, `peers`, `messages` |
| `web/src/signaling.js` | Long-polling signaling client |
| `web/src/webrtc.js` | `RTCPeerConnection` + `mesh-data` channel per peer |
| `web/src/mesh.js` | Gossip, reconnect backoff, routing, ACKs |
| `web/src/qr.js` | Dependency-free QR encoder (byte mode, EC level L) |
| `web/src/scanner.js` | Camera scanning via `BarcodeDetector` |
| `web/src/app.js` | UI controller |
| `web/sw.js`, `web/manifest.webmanifest` | PWA install + offline shell |

No build step and no npm dependencies: the client is native ES modules served
as-is.

## Run

### Local (Python)
```bash
python3 server/signaling.py --port 8080 --static web
```

### Docker
```bash
# Build image
docker build -t p2psecure .

# Run container
docker run -d -p 8080:8080 --name p2psecure-relay p2psecure
```

Or using Docker Compose:
```bash
docker compose up -d
```

### Deploy to Railway

1. Push this repository to GitHub.
2. In [Railway](https://railway.com/), create a **New Project** and select **Deploy from GitHub repo**.
3. Select your repository. Railway automatically detects the `Dockerfile` and `railway.json`.
4. Railway provides an HTTPS domain under **Settings > Networking > Generate Domain**.
5. Phones and browsers can now open your Railway HTTPS URL directly.

Open `http://localhost:8080` (or your Railway HTTPS URL). For phones you need **HTTPS**, otherwise the
browser blocks camera and service worker access. Railway provides automatic HTTPS out-of-the-box.

## Tests

```bash
PYTHONPATH=server python3 -m unittest discover -s server -p 'test_*.py' -v
```

## Protocol

`peerId` is the base64url SHA-256 of the exported SPKI public key, so an invite
is self-verifying: the receiver re-derives the id and rejects mismatches.

`PEER_EXCHANGE` — gossip; entries only overwrite a known peer when `sequence`
is strictly newer, and unverifiable keys are dropped.

```json
{ "type": "PEER_EXCHANGE", "senderId": "...", "peers": [
  { "peerId": "...", "publicKeyPem": "...", "sequence": 12, "signalingToken": "..." } ] }
```

`DATA_PAYLOAD` — signed over `(messageId, senderId, recipientId, payload)`.
Direct hop when the recipient is connected, otherwise flooded to up to two
random neighbours; each hop decrements `ttl` (default 5) and duplicates are
suppressed by `messageId`.

```json
{ "type": "DATA_PAYLOAD", "messageId": "...", "senderId": "...", "recipientId": "...",
  "ttl": 4, "hopCount": 1, "payload": "...", "signature": "..." }
```

`DELIVERY_ACK` — signed over `(messageId, ackFrom, timestamp)` and routed back
the same way, flipping the sender's message from `SENT` to `DELIVERED`.

## Reconnect policy

Backoff ladder is 2s → 5s → 15s → 30s → 60s with ±20% jitter to avoid
reconnect storms. `online` and `visibilitychange` events clear the backoff so a
phone returning to foreground retries immediately.

## Three-phone verification

1. Open the PWA on phones A, B and C, each on a different mobile network.
2. A scans B's invite QR — direct channel opens.
3. C scans B's invite QR — second direct channel opens.
4. A's peer list shows C via gossip, without ever scanning C.
5. Toggle A's connectivity or reload; A reconnects to B automatically.
6. A sends a message to C: B relays it, C verifies and ACKs, A shows
   `DELIVERED`.

The Logs tab traces each step (connect, gossip, relay, ACK).

## Security notes

- Private keys stay in IndexedDB and never leave the device or enter an invite.
- Every accepted message and ACK is signature-verified against a known peer key;
  unknown senders are rejected rather than trusted.
- The relay stores signals in memory only, expires them after 60s, caps queues
  per peer, and never receives message payloads.
- Payloads are signed but not end-to-end encrypted — relays can read message
  text. Adding E2E encryption is the natural next step.
