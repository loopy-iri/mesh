/**
 * Signaling & Zero-Knowledge Blind Mailbox client.
 *
 * Supports:
 * - Live WebRTC SDP/ICE signaling
 * - Multi-relay failover
 * - Zero-knowledge blind mailbox deposit/drain for asynchronous offline messaging
 * - Relay latency / ping testing
 */

export class SignalingClient {
  constructor(baseUrls, peerId, onSignal) {
    const raw = typeof baseUrls === 'string' ? baseUrls.split(/[,\s]+/) : (baseUrls || []);
    const list = raw.map((u) => u.trim()).filter(Boolean);
    this.baseUrls = list.length > 0 ? list : [window.location.origin];
    this.currentUrlIndex = 0;
    this.peerId = peerId;
    this.onSignal = onSignal;
    this.running = false;
  }

  get currentBaseUrl() {
    return (this.baseUrls[this.currentUrlIndex] || '').replace(/\/+$/, '');
  }

  nextRelay() {
    if (this.baseUrls.length > 1) {
      this.currentUrlIndex = (this.currentUrlIndex + 1) % this.baseUrls.length;
    }
  }

  /** Dynamically add relays discovered through P2P mesh gossip. */
  addDiscoveredRelays(urls) {
    const incoming = Array.isArray(urls) ? urls : [urls];
    let added = 0;
    for (const raw of incoming) {
      if (!raw) continue;
      const clean = raw.trim().replace(/\/+$/, '');
      if (clean && !this.baseUrls.includes(clean)) {
        this.baseUrls.push(clean);
        added += 1;
      }
    }
    return added;
  }

  removeRelay(url) {
    const clean = url.trim().replace(/\/+$/, '');
    this.baseUrls = this.baseUrls.filter((u) => u !== clean);
    if (this.baseUrls.length === 0) this.baseUrls = [window.location.origin];
    this.currentUrlIndex = 0;
  }

  /** Ping a relay and measure roundtrip latency. */
  async pingRelay(url) {
    const clean = url.trim().replace(/\/+$/, '');
    const start = performance.now();
    try {
      const response = await fetch(`${clean}/signal/health`, { method: 'GET' });
      const latencyMs = Math.round(performance.now() - start);
      if (!response.ok) return { ok: false, latencyMs, error: response.statusText };
      const data = await response.json();
      return { ok: true, latencyMs, data };
    } catch (err) {
      return { ok: false, latencyMs: Math.round(performance.now() - start), error: err.message };
    }
  }

  /**
   * Send a live signaling envelope (SDP/ICE).
   */
  async send(targetPeerId, signal, targetRelayUrls = null) {
    const targets = [];
    if (targetRelayUrls) {
      const list = Array.isArray(targetRelayUrls) ? targetRelayUrls : [targetRelayUrls];
      for (const u of list) {
        if (u) targets.push(u.trim().replace(/\/+$/, ''));
      }
    }
    for (const u of this.baseUrls) {
      if (!targets.includes(u)) targets.push(u);
    }

    let lastError;
    for (const baseUrl of targets) {
      try {
        const response = await fetch(`${baseUrl}/signal/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetPeerId, senderId: this.peerId, signal }),
        });
        if (response.ok) return;
        lastError = new Error(`signal send failed: ${response.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('All target relays unreachable');
  }

  /**
   * Deposit an E2EE encrypted envelope into a blind mailbox on the relays.
   */
  async depositBlindMailbox(mailboxToken, envelope, targetRelayUrls = null, federate = true) {
    const targets = [];
    if (targetRelayUrls) {
      const list = Array.isArray(targetRelayUrls) ? targetRelayUrls : [targetRelayUrls];
      for (const u of list) {
        if (u) targets.push(u.trim().replace(/\/+$/, ''));
      }
    }
    for (const u of this.baseUrls) {
      if (!targets.includes(u)) targets.push(u);
    }

    let depositedCount = 0;
    for (const baseUrl of targets) {
      try {
        const response = await fetch(`${baseUrl}/mailbox/deposit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mailboxToken, envelope, federate }),
        });
        if (response.ok) depositedCount += 1;
      } catch (err) {
        /* try other relays */
      }
    }
    return depositedCount > 0;
  }

  /**
   * Drain and burn blind mailbox envelopes across all configured relays.
   */
  async drainBlindMailbox(mailboxToken, specificRelayUrls = null) {
    const targets = specificRelayUrls || this.baseUrls;
    const collected = [];

    for (const baseUrl of targets) {
      try {
        const clean = baseUrl.trim().replace(/\/+$/, '');
        const response = await fetch(`${clean}/mailbox/drain/${encodeURIComponent(mailboxToken)}`);
        if (response.ok) {
          const body = await response.json();
          if (Array.isArray(body.envelopes)) {
            collected.push(...body.envelopes);
          }
        }
      } catch (err) {
        /* ignore offline relay */
      }
    }
    return collected;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#loop();
  }

  stop() {
    this.running = false;
  }

  async #loop() {
    while (this.running) {
      try {
        const url = `${this.currentBaseUrl}/signal/poll/${encodeURIComponent(this.peerId)}?wait=20`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`poll failed: ${response.status}`);
        const body = await response.json();
        for (const entry of body.signals || []) {
          try {
            await this.onSignal(entry.senderId, entry.signal);
          } catch (error) {
            console.warn('signal handling failed', error);
          }
        }
      } catch (error) {
        this.nextRelay();
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
}
