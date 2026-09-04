"""Ephemeral WebRTC signaling and Zero-Knowledge Blind Mailbox relay.

Stores nothing but short-lived SDP/ICE envelopes and blind encrypted mailboxes in memory.
No accounts, no plaintext payloads, no disk persistence.

    python3 server/signaling.py --port 8080 --static web
"""

import argparse
import json
import os
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import urllib.request

SIGNAL_TTL_SECONDS = 60
BLIND_MAILBOX_TTL_SECONDS = 86400  # 24 hours in-memory TTL for offline mailboxes
MAX_QUEUE_PER_PEER = 64
MAX_MAILBOX_PER_TOKEN = 128
MAX_BODY_BYTES = 128 * 1024


class Mailboxes:
    """Per-peer bounded queues of signals that expire after SIGNAL_TTL_SECONDS."""

    def __init__(self, ttl=SIGNAL_TTL_SECONDS):
        self._ttl = ttl
        self._lock = threading.Lock()
        self._queues = defaultdict(lambda: deque(maxlen=MAX_QUEUE_PER_PEER))

    def put(self, target_peer_id, envelope):
        envelope = dict(envelope)
        envelope["receivedAt"] = time.time()
        with self._lock:
            self._queues[target_peer_id].append(envelope)

    def drain(self, peer_id):
        cutoff = time.time() - self._ttl
        with self._lock:
            queue = self._queues.pop(peer_id, None)
        if not queue:
            return []
        return [item for item in queue if item["receivedAt"] >= cutoff]

    def sweep(self):
        cutoff = time.time() - self._ttl
        with self._lock:
            for peer_id in list(self._queues):
                queue = self._queues[peer_id]
                while queue and queue[0]["receivedAt"] < cutoff:
                    queue.popleft()
                if not queue:
                    del self._queues[peer_id]

    def stats(self):
        with self._lock:
            return {
                "peersWaiting": len(self._queues),
                "signalsQueued": sum(len(q) for q in self._queues.values()),
                "ttlSeconds": self._ttl,
            }


class BlindMailboxes:
    """Zero-Knowledge blind mailboxes keyed by an anonymous mailboxToken.
    Stores only encrypted envelopes with a TTL. Burn-after-reading upon drain.
    """

    def __init__(self, ttl=BLIND_MAILBOX_TTL_SECONDS):
        self._ttl = ttl
        self._lock = threading.Lock()
        self._boxes = defaultdict(lambda: deque(maxlen=MAX_MAILBOX_PER_TOKEN))

    def put(self, token, envelope):
        item = {
            "envelope": envelope,
            "receivedAt": time.time(),
        }
        with self._lock:
            self._boxes[token].append(item)

    def drain(self, token):
        cutoff = time.time() - self._ttl
        with self._lock:
            queue = self._boxes.pop(token, None)
        if not queue:
            return []
        return [item["envelope"] for item in queue if item["receivedAt"] >= cutoff]

    def peek(self, token):
        cutoff = time.time() - self._ttl
        with self._lock:
            queue = self._boxes.get(token)
            if not queue:
                return []
            return [item["envelope"] for item in queue if item["receivedAt"] >= cutoff]

    def sweep(self):
        cutoff = time.time() - self._ttl
        with self._lock:
            for token in list(self._boxes):
                queue = self._boxes[token]
                while queue and queue[0]["receivedAt"] < cutoff:
                    queue.popleft()
                if not queue:
                    del self._boxes[token]

    def stats(self):
        with self._lock:
            return {
                "tokensActive": len(self._boxes),
                "envelopesStored": sum(len(q) for q in self._boxes.values()),
                "ttlSeconds": self._ttl,
            }


class RelayFederation:
    """Manages connections and cross-forwarding between peer relays."""

    def __init__(self, peer_urls=None):
        self._lock = threading.Lock()
        self._peer_urls = set(peer_urls or [])

    def add_peer(self, url):
        clean = url.strip().rstrip("/")
        if clean:
            with self._lock:
                self._peer_urls.add(clean)

    def get_peers(self):
        with self._lock:
            return list(self._peer_urls)

    def federate_deposit(self, token, envelope):
        """Asynchronously forward a blind deposit to federated peer relays."""
        peers = self.get_peers()
        if not peers:
            return

        def _forward():
            payload = json.dumps({"mailboxToken": token, "envelope": envelope}).encode("utf-8")
            for peer in peers:
                try:
                    req = urllib.request.Request(
                        f"{peer}/relay/federate",
                        data=payload,
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    urllib.request.urlopen(req, timeout=3)
                except Exception:
                    pass

        threading.Thread(target=_forward, daemon=True).start()


MAILBOXES = Mailboxes()
BLIND_MAILBOXES = BlindMailboxes()
FEDERATION = RelayFederation()


def sweeper_loop(stop_event, interval=10):
    while not stop_event.wait(interval):
        MAILBOXES.sweep()
        BLIND_MAILBOXES.sweep()


class SignalingHandler(BaseHTTPRequestHandler):
    server_version = "p2psecure-signaling/2.0"
    static_root = None

    def log_message(self, fmt, *args):
        if os.environ.get("SIGNALING_VERBOSE"):
            super().log_message(fmt, *args)

    # -- helpers ---------------------------------------------------------

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _serve_static(self, path):
        if self.static_root is None:
            self._send_json(404, {"error": "not_found"})
            return
        relative = "index.html" if path in ("/", "") else path.lstrip("/")
        target = os.path.normpath(os.path.join(self.static_root, relative))
        if not target.startswith(os.path.abspath(self.static_root)):
            self._send_json(403, {"error": "forbidden"})
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            self._send_json(404, {"error": "not_found"})
            return
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".webmanifest": "application/manifest+json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
        }.get(os.path.splitext(target)[1], "application/octet-stream")
        with open(target, "rb") as handle:
            body = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # -- routes ----------------------------------------------------------

    def do_OPTIONS(self):
        self._send_json(204, {})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # 1. Live WebRTC Signal send
        if path == "/signal/send":
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "invalid_json"})
                return
            target = payload.get("targetPeerId")
            sender = payload.get("senderId")
            signal = payload.get("signal")
            if not target or not sender or not isinstance(signal, dict):
                self._send_json(400, {"error": "missing_fields"})
                return
            MAILBOXES.put(target, {"senderId": sender, "signal": signal})
            self._send_json(202, {"status": "queued"})
            return

        # 2. Zero-Knowledge Blind Mailbox deposit (for offline store-and-forward)
        if path == "/mailbox/deposit":
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "invalid_json"})
                return
            token = payload.get("mailboxToken")
            envelope = payload.get("envelope")
            if not token or envelope is None:
                self._send_json(400, {"error": "missing_token_or_envelope"})
                return
            BLIND_MAILBOXES.put(token, envelope)
            if payload.get("federate", False):
                FEDERATION.federate_deposit(token, envelope)
            self._send_json(202, {"status": "deposited", "token": token})
            return

        # 3. Inter-relay federation ingestion
        if path == "/relay/federate":
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._send_json(400, {"error": "invalid_json"})
                return
            token = payload.get("mailboxToken")
            envelope = payload.get("envelope")
            if token and envelope is not None:
                BLIND_MAILBOXES.put(token, envelope)
            self._send_json(202, {"status": "federated"})
            return

        # 4. Join relay federation
        if path == "/relay/join":
            payload = self._read_json()
            if isinstance(payload, dict) and payload.get("relayUrl"):
                FEDERATION.add_peer(payload["relayUrl"])
            self._send_json(200, {"status": "joined", "peers": FEDERATION.get_peers()})
            return

        self._send_json(404, {"error": "not_found"})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # Live WebRTC Signal poll
        if path.startswith("/signal/poll/"):
            peer_id = path[len("/signal/poll/"):]
            if not peer_id:
                self._send_json(400, {"error": "missing_peer_id"})
                return
            wait_seconds = _clamp_float(parse_qs(parsed.query).get("wait", ["0"])[0], 0.0, 25.0)
            signals = _poll_with_wait(peer_id, wait_seconds)
            self._send_json(200, {"peerId": peer_id, "signals": signals})
            return

        # Healthcheck
        if path == "/signal/health":
            self._send_json(200, {
                "status": "ok",
                "signaling": MAILBOXES.stats(),
                "blindMailboxes": BLIND_MAILBOXES.stats(),
                "federatedPeers": len(FEDERATION.get_peers()),
            })
            return

        # Blind Mailbox drain (Burn-after-reading: returns and immediately deletes)
        if path.startswith("/mailbox/drain/"):
            token = path[len("/mailbox/drain/"):]
            if not token:
                self._send_json(400, {"error": "missing_token"})
                return
            envelopes = BLIND_MAILBOXES.drain(token)
            self._send_json(200, {"mailboxToken": token, "envelopes": envelopes})
            return

        # Blind Mailbox poll (wait for new envelope arrival)
        if path.startswith("/mailbox/poll/"):
            token = path[len("/mailbox/poll/"):]
            if not token:
                self._send_json(400, {"error": "missing_token"})
                return
            wait_seconds = _clamp_float(parse_qs(parsed.query).get("wait", ["0"])[0], 0.0, 25.0)
            envelopes = _poll_blind_mailbox(token, wait_seconds)
            self._send_json(200, {"mailboxToken": token, "envelopes": envelopes})
            return

        # List federated peer relays
        if path == "/relay/peers":
            self._send_json(200, {"peers": FEDERATION.get_peers()})
            return

        self._serve_static(path)


def _clamp_float(raw, low, high):
    try:
        return max(low, min(high, float(raw)))
    except (TypeError, ValueError):
        return low


def _poll_with_wait(peer_id, wait_seconds, tick=0.25):
    """Long-poll: return as soon as a signal arrives, else after wait_seconds."""
    deadline = time.monotonic() + wait_seconds
    while True:
        signals = MAILBOXES.drain(peer_id)
        if signals or time.monotonic() >= deadline:
            return [
                {"senderId": item["senderId"], "signal": item["signal"]}
                for item in signals
            ]
        time.sleep(tick)


def _poll_blind_mailbox(token, wait_seconds, tick=0.25):
    """Long-poll blind mailbox: return as soon as an envelope arrives, else after wait_seconds."""
    deadline = time.monotonic() + wait_seconds
    while True:
        envelopes = BLIND_MAILBOXES.drain(token)
        if envelopes or time.monotonic() >= deadline:
            return envelopes
        time.sleep(tick)


def build_server(port, static_root, host="0.0.0.0"):
    handler = type("BoundSignalingHandler", (SignalingHandler,), {
        "static_root": os.path.abspath(static_root) if static_root else None,
    })
    return ThreadingHTTPServer((host, port), handler)


def main():
    parser = argparse.ArgumentParser(description="Ephemeral WebRTC signaling & Blind Mailbox relay")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--static", default="web", help="directory to serve the PWA from")
    parser.add_argument("--peer-relays", nargs="*", default=[], help="list of federated peer relays")
    args = parser.parse_args()

    # Register initial peer relays from CLI or env
    env_relays = [r.strip() for r in os.environ.get("PEER_RELAYS", "").split() if r.strip()]
    for p in (args.peer_relays + env_relays):
        FEDERATION.add_peer(p)

    httpd = build_server(args.port, args.static, args.host)
    stop_event = threading.Event()
    sweeper = threading.Thread(target=sweeper_loop, args=(stop_event,), daemon=True)
    sweeper.start()
    print("signaling & blind mailbox relay on http://%s:%d (static: %s)" % (args.host, args.port, args.static))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        httpd.server_close()


if __name__ == "__main__":
    main()
