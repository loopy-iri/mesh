/**
 * Mesh engine: gossip peer discovery, exponential-backoff reconnection and
 * store-and-forward message routing over WebRTC DataChannels.
 */

import { derivePeerId, randomId, signData, verifySignature } from './crypto.js';
import { messageStore, peerStore } from './db.js';
import { SignalingClient } from './signaling.js';
import { WebRtcManager } from './webrtc.js';

export const DEFAULT_TTL = 5;
export const GOSSIP_INTERVAL_MS = 30_000;
export const RECONNECT_TICK_MS = 2_000;
export const BACKOFF_LADDER_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const RANDOM_FANOUT = 2;
const SEEN_MESSAGE_LIMIT = 500;

/** Backoff delay for the Nth consecutive failure, with +/-20% jitter. */
export function backoffDelay(failureCount, random = Math.random) {
  const index = Math.min(Math.max(failureCount, 1), BACKOFF_LADDER_MS.length) - 1;
  const base = BACKOFF_LADDER_MS[index];
  return Math.round(base * (0.8 + random() * 0.4));
}

export function newPeerRecord(peer, source) {
  return {
    peerId: peer.peerId,
    publicKeyPem: peer.publicKeyPem,
    alias: peer.alias || '',
    source,
    signalingToken: peer.signalingToken || peer.peerId,
    sequence: peer.sequence || 1,
    lastSeen: Date.now(),
    lastConnected: null,
    failureCount: 0,
    nextRetryAt: 0,
    status: 'DISCONNECTED',
  };
}

/** Merge an incoming gossip entry; only strictly newer sequences win. */
export function mergePeerRecord(existing, incoming) {
  if (!existing) return newPeerRecord(incoming, 'GOSSIP');
  if ((incoming.sequence || 0) <= existing.sequence) {
    return { ...existing, lastSeen: Date.now() };
  }
  return {
    ...existing,
    publicKeyPem: incoming.publicKeyPem || existing.publicKeyPem,
    signalingToken: incoming.signalingToken || existing.signalingToken,
    sequence: incoming.sequence,
    lastSeen: Date.now(),
  };
}

/** Peers eligible for a reconnect attempt right now, freshest contacts first. */
export function selectReconnectCandidates(peers, now = Date.now()) {
  return peers
    .filter((peer) => peer.status === 'DISCONNECTED' && (peer.nextRetryAt || 0) <= now)
    .sort((left, right) => (right.lastConnected || 0) - (left.lastConnected || 0));
}

export class MeshNode extends EventTarget {
  constructor(identity, relayUrl) {
    super();
    this.identity = identity;
    this.relayUrl = relayUrl;
    this.sequence = 1;
    this.seenMessageIds = new Set();
    this.timers = [];

    this.signaling = new SignalingClient(relayUrl, identity.peerId, (senderId, signal) =>
      this.webrtc.handleSignal(senderId, signal),
    );
    this.webrtc = new WebRtcManager({
      selfId: identity.peerId,
      signaling: this.signaling,
      onChannelOpen: (peerId) => this.#handleChannelOpen(peerId),
      onChannelClose: (peerId) => this.#handleChannelClose(peerId),
      onMessage: (peerId, packet) => this.#handlePacket(peerId, packet),
    });
  }

  // -- lifecycle -------------------------------------------------------

  async start() {
    this.signaling.start();
    await this.#resetPeerStatuses();
    this.timers.push(setInterval(() => this.publishGossip(), GOSSIP_INTERVAL_MS));
    this.timers.push(setInterval(() => this.runReconnectPass(), RECONNECT_TICK_MS));
    this.onlineHandler = () => this.wakeUp();
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') this.wakeUp();
    };
    window.addEventListener('online', this.onlineHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.runReconnectPass();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    window.removeEventListener('online', this.onlineHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.signaling.stop();
    this.webrtc.closeAll();
  }

  /** Clear backoff so a returning-to-foreground / back-online app retries fast. */
  async wakeUp() {
    const peers = await peerStore.all();
    await Promise.all(
      peers
        .filter((peer) => peer.status !== 'CONNECTED')
        .map((peer) => peerStore.put({ ...peer, nextRetryAt: 0, status: 'DISCONNECTED' })),
    );
    this.runReconnectPass();
    this.#emitChange();
  }

  async #resetPeerStatuses() {
    const peers = await peerStore.all();
    await Promise.all(
      peers.map((peer) => peerStore.put({ ...peer, status: 'DISCONNECTED', nextRetryAt: 0 })),
    );
  }

  #emitChange() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  #log(text) {
    this.dispatchEvent(new CustomEvent('log', { detail: text }));
  }

  // -- invites ---------------------------------------------------------

  buildInvite() {
    return JSON.stringify({
      v: 1,
      peerId: this.identity.peerId,
      publicKeyPem: this.identity.publicKeyPem,
      relayUrl: this.relayUrl,
    });
  }

  async acceptInvite(rawInvite) {
    const invite = JSON.parse(rawInvite);
    if (!invite.peerId || !invite.publicKeyPem) throw new Error('invite missing fields');
    const derived = await derivePeerId(invite.publicKeyPem);
    if (derived !== invite.peerId) throw new Error('invite peerId does not match public key');
    if (invite.peerId === this.identity.peerId) throw new Error('that is your own invite');

    const existing = await peerStore.get(invite.peerId);
    const record = existing
      ? { ...existing, publicKeyPem: invite.publicKeyPem, source: 'MANUAL_QR', nextRetryAt: 0 }
      : newPeerRecord(invite, 'MANUAL_QR');
    await peerStore.put(record);
    this.#emitChange();
    await this.dialPeer(invite.peerId);
    return record;
  }

  // -- connection management -------------------------------------------

  async dialPeer(peerId) {
    if (this.webrtc.isBusy(peerId)) return;
    const peer = await peerStore.get(peerId);
    if (!peer) return;
    await peerStore.put({ ...peer, status: 'CONNECTING' });
    this.#emitChange();
    try {
      await this.webrtc.dial(peerId);
    } catch (error) {
      await this.#markFailure(peerId);
      this.#log(`dial failed for ${peerId.slice(0, 8)}: ${error.message}`);
    }
  }

  async runReconnectPass() {
    const peers = await peerStore.all();
    for (const peer of selectReconnectCandidates(peers)) {
      if (this.webrtc.isBusy(peer.peerId)) continue;
      // Reserve the slot before dialing so the next tick does not double-dial.
      await peerStore.put({
        ...peer,
        status: 'CONNECTING',
        nextRetryAt: Date.now() + backoffDelay(peer.failureCount + 1),
      });
      this.webrtc.dial(peer.peerId).catch(() => this.#markFailure(peer.peerId));
    }
    this.#emitChange();
  }

  async #markFailure(peerId) {
    const peer = await peerStore.get(peerId);
    if (!peer) return;
    const failureCount = (peer.failureCount || 0) + 1;
    await peerStore.put({
      ...peer,
      status: 'DISCONNECTED',
      failureCount,
      nextRetryAt: Date.now() + backoffDelay(failureCount),
    });
    this.#emitChange();
  }

  async #handleChannelOpen(peerId) {
    const peer = await peerStore.get(peerId);
    if (peer) {
      await peerStore.put({
        ...peer,
        status: 'CONNECTED',
        failureCount: 0,
        nextRetryAt: 0,
        lastConnected: Date.now(),
        lastSeen: Date.now(),
      });
    }
    this.#log(`connected to ${peerId.slice(0, 8)}`);
    await this.publishGossip(peerId);
    await this.flushPending();
    this.#emitChange();
  }

  async #handleChannelClose(peerId) {
    this.#log(`disconnected from ${peerId.slice(0, 8)}`);
    await this.#markFailure(peerId);
  }

  // -- gossip ----------------------------------------------------------

  async publishGossip(targetPeerId = null) {
    const peers = await peerStore.all();
    const entries = [
      {
        peerId: this.identity.peerId,
        publicKeyPem: this.identity.publicKeyPem,
        sequence: this.sequence,
        signalingToken: this.identity.peerId,
      },
      ...peers.map((peer) => ({
        peerId: peer.peerId,
        publicKeyPem: peer.publicKeyPem,
        sequence: peer.sequence,
        signalingToken: peer.signalingToken,
      })),
    ];
    const packet = { type: 'PEER_EXCHANGE', senderId: this.identity.peerId, peers: entries };
    if (targetPeerId) this.webrtc.send(targetPeerId, packet);
    else this.webrtc.broadcast(packet);
    this.sequence += 1;
  }

  async #handlePeerExchange(packet) {
    let learned = 0;
    for (const entry of packet.peers || []) {
      if (!entry.peerId || entry.peerId === this.identity.peerId) continue;
      if (!entry.publicKeyPem) continue;
      if ((await derivePeerId(entry.publicKeyPem)) !== entry.peerId) continue;
      const existing = await peerStore.get(entry.peerId);
      if (!existing) learned += 1;
      await peerStore.put(mergePeerRecord(existing, entry));
    }
    if (learned > 0) this.#log(`gossip: learned ${learned} new peer(s)`);
    this.#emitChange();
  }

  // -- messaging -------------------------------------------------------

  async sendMessage(recipientId, payload) {
    const messageId = randomId();
    const signature = await signData(this.identity.privateKeyPem, [
      messageId,
      this.identity.peerId,
      recipientId,
      payload,
    ]);
    const record = {
      messageId,
      senderId: this.identity.peerId,
      recipientId,
      hopCount: 0,
      ttl: DEFAULT_TTL,
      payload,
      signature,
      status: 'PENDING',
      createdAt: Date.now(),
      deliveredAt: null,
    };
    await messageStore.put(record);
    this.seenMessageIds.add(messageId);
    const routed = this.#route({
      type: 'DATA_PAYLOAD',
      messageId,
      senderId: this.identity.peerId,
      recipientId,
      ttl: DEFAULT_TTL,
      hopCount: 0,
      payload,
      signature,
    });
    await messageStore.put({ ...record, status: routed ? 'SENT' : 'PENDING' });
    this.#emitChange();
    return record;
  }

  /** Re-route messages that never found a next hop when first sent. */
  async flushPending() {
    const messages = await messageStore.all();
    for (const message of messages) {
      if (message.status !== 'PENDING' || message.senderId !== this.identity.peerId) continue;
      const routed = this.#route({
        type: 'DATA_PAYLOAD',
        messageId: message.messageId,
        senderId: message.senderId,
        recipientId: message.recipientId,
        ttl: DEFAULT_TTL,
        hopCount: 0,
        payload: message.payload,
        signature: message.signature,
      });
      if (routed) await messageStore.put({ ...message, status: 'SENT' });
    }
    this.#emitChange();
  }

  /** Direct hop when possible, otherwise flood to a few random neighbours. */
  #route(packet, exceptPeerId = null) {
    if (this.webrtc.isConnected(packet.recipientId)) {
      return this.webrtc.send(packet.recipientId, packet);
    }
    const candidates = this.webrtc
      .connectedPeerIds()
      .filter((peerId) => peerId !== exceptPeerId && peerId !== packet.senderId);
    if (candidates.length === 0) return false;
    const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, RANDOM_FANOUT);
    let delivered = 0;
    for (const peerId of shuffled) {
      if (this.webrtc.send(peerId, packet)) delivered += 1;
    }
    return delivered > 0;
  }

  #remember(messageId) {
    if (this.seenMessageIds.has(messageId)) return false;
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size > SEEN_MESSAGE_LIMIT) {
      this.seenMessageIds.delete(this.seenMessageIds.values().next().value);
    }
    return true;
  }

  async #handlePacket(fromPeerId, packet) {
    if (packet.type === 'PEER_EXCHANGE') return this.#handlePeerExchange(packet);
    if (packet.type === 'DATA_PAYLOAD') return this.#handleDataPayload(fromPeerId, packet);
    if (packet.type === 'DELIVERY_ACK') return this.#handleAck(packet);
    return undefined;
  }

  async #handleDataPayload(fromPeerId, packet) {
    if (!this.#remember(packet.messageId)) return;

    if (packet.recipientId !== this.identity.peerId) {
      const ttl = (packet.ttl || 0) - 1;
      if (ttl <= 0) return;
      this.#route({ ...packet, ttl, hopCount: (packet.hopCount || 0) + 1 }, fromPeerId);
      this.#log(`relayed ${packet.messageId.slice(0, 8)} (ttl ${ttl})`);
      return;
    }

    const sender = await peerStore.get(packet.senderId);
    const valid = sender
      ? await verifySignature(
          sender.publicKeyPem,
          [packet.messageId, packet.senderId, packet.recipientId, packet.payload],
          packet.signature,
        )
      : false;
    if (!valid) {
      this.#log(`rejected ${packet.messageId.slice(0, 8)}: bad signature or unknown sender`);
      return;
    }

    await messageStore.put({
      messageId: packet.messageId,
      senderId: packet.senderId,
      recipientId: packet.recipientId,
      hopCount: packet.hopCount || 0,
      ttl: packet.ttl || 0,
      payload: packet.payload,
      signature: packet.signature,
      status: 'DELIVERED',
      createdAt: Date.now(),
      deliveredAt: Date.now(),
    });

    const timestamp = Date.now();
    const ackSignature = await signData(this.identity.privateKeyPem, [
      packet.messageId,
      this.identity.peerId,
      timestamp,
    ]);
    this.#route(
      {
        type: 'DELIVERY_ACK',
        messageId: packet.messageId,
        recipientId: packet.senderId,
        senderId: this.identity.peerId,
        ackFrom: this.identity.peerId,
        ttl: DEFAULT_TTL,
        timestamp,
        signature: ackSignature,
      },
      fromPeerId,
    );
    this.#log(`delivered message from ${packet.senderId.slice(0, 8)}`);
    this.#emitChange();
  }

  async #handleAck(packet) {
    if (packet.recipientId !== this.identity.peerId) {
      const ttl = (packet.ttl || 0) - 1;
      if (ttl <= 0) return;
      this.#route({ ...packet, ttl });
      return;
    }
    const message = await messageStore.get(packet.messageId);
    if (!message || message.senderId !== this.identity.peerId) return;

    const acker = await peerStore.get(packet.ackFrom);
    const valid = acker
      ? await verifySignature(
          acker.publicKeyPem,
          [packet.messageId, packet.ackFrom, packet.timestamp],
          packet.signature,
        )
      : false;
    if (!valid) return;

    await messageStore.put({ ...message, status: 'DELIVERED', deliveredAt: packet.timestamp });
    this.#log(`ACK for ${packet.messageId.slice(0, 8)}`);
    this.#emitChange();
  }
}
