/**
 * Air-gapped / Serverless WebRTC Direct Connect.
 *
 * Allows two phones or devices to establish a direct P2P DataChannel without
 * ANY signaling server or internet connection (e.g. over local Wi-Fi or mobile hotspot):
 *
 * 1. Device A creates an Offer -> displayed as Offer QR code.
 * 2. Device B scans Offer QR -> automatically generates Answer QR.
 * 3. Device A scans Answer QR -> connection established directly!
 */

import { compressString, decompressString } from './crypto.js';

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

function waitForIceGathering(connection, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const check = () => {
      if (connection.iceGatheringState === 'complete') {
        connection.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    connection.addEventListener('icegatheringstatechange', check);
    setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, timeoutMs);
  });
}

export class DirectConnectManager {
  constructor({ identity, onConnected }) {
    this.identity = identity;
    this.onConnected = onConnected;
    this.connection = null;
    this.dataChannel = null;
  }

  /**
   * Step 1 (Device A): Create an offline Offer package.
   */
  async createOfferPackage() {
    this.cleanup();
    this.connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.dataChannel = this.connection.createDataChannel('mesh-data', { ordered: true });
    this.#bindChannel(this.dataChannel);

    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    await waitForIceGathering(this.connection);

    const payload = {
      t: 'OFFER',
      id: this.identity.peerId,
      k: this.identity.publicKeyPem,
      s: this.connection.localDescription.sdp,
    };

    const compressed = await compressString(JSON.stringify(payload));
    return `P2P:${compressed}`;
  }

  /**
   * Step 2 (Device B): Receive Offer package and generate Answer package.
   */
  async processOfferAndCreateAnswer(rawString) {
    this.cleanup();
    const clean = rawString.startsWith('P2P:') ? rawString.slice(4) : rawString;
    const jsonStr = await decompressString(clean);
    const offerPkg = JSON.parse(jsonStr);

    if (offerPkg.t !== 'OFFER' || !offerPkg.s) {
      throw new Error('کد نامعتبر است: این بسته یک Offer معتبر نیست');
    }

    this.remotePeer = {
      peerId: offerPkg.id,
      publicKeyPem: offerPkg.k,
    };

    this.connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.connection.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.#bindChannel(this.dataChannel);
    };

    await this.connection.setRemoteDescription({
      type: 'offer',
      sdp: offerPkg.s,
    });

    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    await waitForIceGathering(this.connection);

    const answerPkg = {
      t: 'ANSWER',
      id: this.identity.peerId,
      k: this.identity.publicKeyPem,
      s: this.connection.localDescription.sdp,
    };

    const compressed = await compressString(JSON.stringify(answerPkg));
    return {
      answerCode: `P2P:${compressed}`,
      remotePeer: this.remotePeer,
    };
  }

  /**
   * Step 3 (Device A): Receive Answer package to finalize the connection.
   */
  async processAnswer(rawString) {
    if (!this.connection) {
      throw new Error('اتصالی برای اعمال پاسخ وجود ندارد. لطفاً از ابتدا کد آفلاین بسازید.');
    }
    const clean = rawString.startsWith('P2P:') ? rawString.slice(4) : rawString;
    const jsonStr = await decompressString(clean);
    const answerPkg = JSON.parse(jsonStr);

    if (answerPkg.t !== 'ANSWER' || !answerPkg.s) {
      throw new Error('کد نامعتبر است: این بسته یک Answer معتبر نیست');
    }

    this.remotePeer = {
      peerId: answerPkg.id,
      publicKeyPem: answerPkg.k,
    };

    await this.connection.setRemoteDescription({
      type: 'answer',
      sdp: answerPkg.s,
    });

    return this.remotePeer;
  }

  #bindChannel(channel) {
    channel.onopen = () => {
      if (this.remotePeer && this.onConnected) {
        this.onConnected(this.remotePeer, this.connection, channel);
      }
    };
  }

  cleanup() {
    if (this.connection) {
      try {
        this.connection.close();
      } catch (e) {
        /* ignore */
      }
      this.connection = null;
    }
    this.dataChannel = null;
    this.remotePeer = null;
  }
}
