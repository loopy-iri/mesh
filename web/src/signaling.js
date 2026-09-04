/**
 * Long-polling client for the ephemeral signaling relay. Only carries
 * SDP offers/answers and ICE candidates.
 */

export class SignalingClient {
  constructor(baseUrl, peerId, onSignal) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.peerId = peerId;
    this.onSignal = onSignal;
    this.running = false;
  }

  async send(targetPeerId, signal) {
    const response = await fetch(`${this.baseUrl}/signal/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPeerId, senderId: this.peerId, signal }),
    });
    if (!response.ok) throw new Error(`signal send failed: ${response.status}`);
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
        const url = `${this.baseUrl}/signal/poll/${encodeURIComponent(this.peerId)}?wait=20`;
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
        // Relay unreachable (offline, restart). Back off briefly and retry.
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
}
