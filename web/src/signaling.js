/**
 * Long-polling client for the ephemeral signaling relay. Only carries
 * SDP offers/answers and ICE candidates.
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

  /**
   * Send a signaling envelope.
   * If targetRelayUrls is specified, tries reaching the target's advertised relays first!
   */
  async send(targetPeerId, signal, targetRelayUrls = null) {
    const targets = [];
    if (targetRelayUrls) {
      const list = Array.isArray(targetRelayUrls) ? targetRelayUrls : [targetRelayUrls];
      for (const u of list) {
        if (u) targets.push(u.trim().replace(/\/+$/, ''));
      }
    }
    // Also append current relay pool as fallback
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
        // Switch to next relay if available and back off
        this.nextRelay();
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
}

