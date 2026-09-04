/**
 * Camera QR scanning via the native BarcodeDetector API when available.
 * Callers should fall back to pasting the invite text when
 * `isScannerSupported()` is false (e.g. Safari, Firefox).
 */

export function isScannerSupported() {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

export class QrScanner {
  constructor(videoElement, onResult) {
    this.video = videoElement;
    this.onResult = onResult;
    this.stream = null;
    this.detector = null;
    this.timer = null;
  }

  async start() {
    if (!isScannerSupported()) throw new Error('BarcodeDetector unavailable');
    this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.timer = setInterval(() => this.#tick(), 400);
  }

  async #tick() {
    if (!this.detector || this.video.readyState < 2) return;
    try {
      const codes = await this.detector.detect(this.video);
      if (codes.length > 0 && codes[0].rawValue) {
        this.onResult(codes[0].rawValue);
      }
    } catch (error) {
      /* transient decode failure */
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }
}
