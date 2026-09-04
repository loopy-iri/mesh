"""Ephemeral WebRTC signaling relay.

Stores nothing but short-lived SDP/ICE envelopes in memory. No accounts, no
message payloads. Standard library only so it runs anywhere Python 3.9+ does.

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

SIGNAL_TTL_SECONDS = 60
MAX_QUEUE_PER_PEER = 64
MAX_BODY_BYTES = 64 * 1024


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


MAILBOXES = Mailboxes()


def sweeper_loop(stop_event, interval=10):
    while not stop_event.wait(interval):
        MAILBOXES.sweep()


class SignalingHandler(BaseHTTPRequestHandler):
    server_version = "p2psecure-signaling/1.0"
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
        if urlparse(self.path).path != "/signal/send":
            self._send_json(404, {"error": "not_found"})
            return
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

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/signal/poll/"):
            peer_id = path[len("/signal/poll/"):]
            if not peer_id:
                self._send_json(400, {"error": "missing_peer_id"})
                return
            wait_seconds = _clamp_float(parse_qs(parsed.query).get("wait", ["0"])[0], 0.0, 25.0)
            signals = _poll_with_wait(peer_id, wait_seconds)
            self._send_json(200, {"peerId": peer_id, "signals": signals})
            return
        if path == "/signal/health":
            self._send_json(200, {"status": "ok", **MAILBOXES.stats()})
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


def build_server(port, static_root, host="0.0.0.0"):
    handler = type("BoundSignalingHandler", (SignalingHandler,), {
        "static_root": os.path.abspath(static_root) if static_root else None,
    })
    return ThreadingHTTPServer((host, port), handler)


def main():
    parser = argparse.ArgumentParser(description="Ephemeral WebRTC signaling relay")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--static", default="web", help="directory to serve the PWA from")
    args = parser.parse_args()

    httpd = build_server(args.port, args.static, args.host)
    stop_event = threading.Event()
    sweeper = threading.Thread(target=sweeper_loop, args=(stop_event,), daemon=True)
    sweeper.start()
    print("signaling relay on http://%s:%d (static: %s)" % (args.host, args.port, args.static))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        httpd.server_close()


if __name__ == "__main__":
    main()
