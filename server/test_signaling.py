"""Tests for the signaling relay: mailbox semantics plus live HTTP round-trip."""

import json
import threading
import time
import unittest
import urllib.error
import urllib.request

import signaling


class MailboxTests(unittest.TestCase):
    def test_drain_returns_and_clears_signals(self):
        box = signaling.Mailboxes()
        box.put("peer-b", {"senderId": "peer-a", "signal": {"kind": "sdp"}})
        first = box.drain("peer-b")
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]["senderId"], "peer-a")
        self.assertEqual(box.drain("peer-b"), [])

    def test_expired_signals_are_dropped(self):
        box = signaling.Mailboxes(ttl=0.05)
        box.put("peer-b", {"senderId": "peer-a", "signal": {}})
        time.sleep(0.1)
        self.assertEqual(box.drain("peer-b"), [])

    def test_sweep_removes_empty_queues(self):
        box = signaling.Mailboxes(ttl=0.05)
        box.put("peer-b", {"senderId": "peer-a", "signal": {}})
        time.sleep(0.1)
        box.sweep()
        self.assertEqual(box.stats()["peersWaiting"], 0)

    def test_queue_is_bounded(self):
        box = signaling.Mailboxes()
        for index in range(signaling.MAX_QUEUE_PER_PEER + 10):
            box.put("peer-b", {"senderId": "peer-a", "signal": {"n": index}})
        self.assertEqual(len(box.drain("peer-b")), signaling.MAX_QUEUE_PER_PEER)


class HttpRelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = signaling.build_server(0, static_root="web", host="127.0.0.1")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def post(self, path, payload):
        request = urllib.request.Request(
            self.url(path),
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return urllib.request.urlopen(request, timeout=5)

    def get(self, path):
        return urllib.request.urlopen(self.url(path), timeout=30)

    def test_health(self):
        body = json.loads(self.get("/signal/health").read())
        self.assertEqual(body["status"], "ok")

    def test_offer_answer_round_trip(self):
        offer = {"kind": "sdp", "description": {"type": "offer", "sdp": "v=0"}}
        self.assertEqual(self.post("/signal/send", {
            "targetPeerId": "peer-b", "senderId": "peer-a", "signal": offer,
        }).status, 202)

        body = json.loads(self.get("/signal/poll/peer-b").read())
        self.assertEqual(len(body["signals"]), 1)
        self.assertEqual(body["signals"][0]["senderId"], "peer-a")
        self.assertEqual(body["signals"][0]["signal"], offer)

        # Signals are consumed exactly once.
        again = json.loads(self.get("/signal/poll/peer-b").read())
        self.assertEqual(again["signals"], [])

    def test_long_poll_wakes_on_arrival(self):
        result = {}

        def poll():
            result["body"] = json.loads(self.get("/signal/poll/peer-c?wait=5").read())

        thread = threading.Thread(target=poll)
        thread.start()
        time.sleep(0.3)
        self.post("/signal/send", {
            "targetPeerId": "peer-c", "senderId": "peer-a", "signal": {"kind": "ice"},
        })
        thread.join(timeout=6)
        self.assertEqual(len(result["body"]["signals"]), 1)

    def test_rejects_incomplete_payload(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post("/signal/send", {"targetPeerId": "peer-b"})
        self.assertEqual(caught.exception.code, 400)

    def test_serves_pwa_shell(self):
        response = self.get("/index.html")
        self.assertEqual(response.status, 200)
        self.assertIn(b"P2P Secure Mesh", response.read())

    def test_static_path_traversal_blocked(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/../server/signaling.py")
        self.assertIn(caught.exception.code, (403, 404))


if __name__ == "__main__":
    unittest.main()
