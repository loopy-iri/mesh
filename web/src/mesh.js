/**
 * Mesh engine: gossip peer discovery, exponential-backoff reconnection,
 * store-and-forward message routing, blockchain ledger sealing, serverless air-gap,
 * and decentralized connection descriptor & service directory synchronization.
 */

import {
  derivePeerId,
  randomId,
  signData,
  verifySignature,
  signDescriptor,
  verifyDescriptorSignature,
  deriveMailboxToken,
  encryptEnvelope,
  decryptEnvelope,
} from './crypto.js';
import { messageStore, peerStore, ledgerStore, serviceStore, mailboxQueueStore } from './db.js';
import { createBlock, validateBlock, PUBLIC_CHANNEL } from './ledger.js';
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
  const relays = Array.isArray(peer.relayUrls)
    ? peer.relayUrls
    : (peer.relayUrl ? [peer.relayUrl] : []);

  return {
    peerId: peer.peerId,
    publicKeyPem: peer.publicKeyPem,
    alias: peer.alias || '',
    source,
    relayUrls: relays,
    descriptorSignature: peer.descriptorSignature || peer.signature || null,
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
  if ((incoming.sequence || 0) <= (existing.sequence || 0)) {
    return { ...existing, lastSeen: Date.now() };
  }
  const incomingRelays = Array.isArray(incoming.relayUrls)
    ? incoming.relayUrls
    : (incoming.relayUrl ? [incoming.relayUrl] : (existing.relayUrls || []));

  return {
    ...existing,
    publicKeyPem: incoming.publicKeyPem || existing.publicKeyPem,
    relayUrls: incomingRelays,
    alias: incoming.alias !== undefined ? incoming.alias : existing.alias,
    descriptorSignature: incoming.descriptorSignature || incoming.signature || existing.descriptorSignature,
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
  constructor(identity, relayUrls) {
    super();
    this.identity = identity;

    const rawList = typeof relayUrls === 'string' ? relayUrls.split(/[,\s]+/) : (relayUrls || []);
    this.relayUrls = rawList.map((u) => u.trim()).filter(Boolean);
    if (this.relayUrls.length === 0) this.relayUrls = [window.location.origin];

    const storedSeq = parseInt(localStorage.getItem('p2psecure.descriptorSeq') || '1', 10);
    this.sequence = isNaN(storedSeq) ? 1 : storedSeq;
    this.alias = localStorage.getItem('p2psecure.userAlias') || '';
    // Every device inherently acts as a mobile mesh relay by default!
    this.phoneRelayMode = localStorage.getItem('p2psecure.phoneRelayMode') !== 'false';
    this.isInternetGateway = false;
    this.knownGateways = new Set();

    this.seenMessageIds = new Set();
    this.timers = [];

    this.signaling = new SignalingClient(this.relayUrls, identity.peerId, (senderId, signal) =>
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
    await this.#loadStoredServices();

    this.timers.push(setInterval(() => this.publishGossip(), GOSSIP_INTERVAL_MS));
    this.timers.push(setInterval(() => this.runReconnectPass(), RECONNECT_TICK_MS));
    // Periodic drain of blind mailboxes from all relays (every 25 seconds)
    this.timers.push(setInterval(() => this.drainMyBlindMailbox(), 25_000));
    // Check internet connectivity & gateway bridge status (every 10 seconds)
    this.timers.push(setInterval(() => this.checkInternet(), 10_000));

    this.onlineHandler = () => this.wakeUp();
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') this.wakeUp();
    };
    window.addEventListener('online', this.onlineHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.runReconnectPass();
    this.checkInternet();
    this.drainMyBlindMailbox();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    window.removeEventListener('online', this.onlineHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.signaling.stop();
    this.webrtc.closeAll();
  }

  async checkInternet() {
    if (!navigator.onLine) {
      if (this.isInternetGateway) {
        this.isInternetGateway = false;
        this.#emitChange();
      }
      return false;
    }
    try {
      const primaryUrl = this.relayUrls[0] || window.location.origin;
      const res = await this.signaling.pingRelay(primaryUrl, 2500);
      const prev = this.isInternetGateway;
      this.isInternetGateway = Boolean(res.ok);
      if (prev !== this.isInternetGateway) {
        if (this.isInternetGateway) {
          this.#log('اینترنت فعال است: این دستگاه نقش پل اینترنت (Internet Gateway Bridge) برای سایر همتایان مش را دارد.');
        }
        this.#emitChange();
      }
      return this.isInternetGateway;
    } catch {
      this.isInternetGateway = false;
      return false;
    }
  }

  async wakeUp() {
    const peers = await peerStore.all();
    await Promise.all(
      peers
        .filter((peer) => peer.status !== 'CONNECTED')
        .map((peer) => peerStore.put({ ...peer, nextRetryAt: 0, status: 'DISCONNECTED' })),
    );
    this.checkInternet();
    this.runReconnectPass();
    this.drainMyBlindMailbox();
    this.#emitChange();
  }

  async #resetPeerStatuses() {
    const peers = await peerStore.all();
    await Promise.all(
      peers.map((peer) => peerStore.put({ ...peer, status: 'DISCONNECTED', nextRetryAt: 0 })),
    );
  }

  async #loadStoredServices() {
    const services = await serviceStore.all();
    const urls = services.map((s) => s.url).filter(Boolean);
    if (urls.length > 0) {
      this.signaling.addDiscoveredRelays(urls);
    }
  }

  #emitChange() {
    this.dispatchEvent(new CustomEvent('change'));
  }

  #log(text) {
    this.dispatchEvent(new CustomEvent('log', { detail: text }));
  }

  // -- connection descriptors & invites ---------------------------------

  async buildDescriptor() {
    const desc = {
      peerId: this.identity.peerId,
      publicKeyPem: this.identity.publicKeyPem,
      sequence: this.sequence,
      relayUrls: this.relayUrls,
      alias: this.alias,
      isMobileRelay: this.phoneRelayMode,
      isInternetGateway: this.isInternetGateway,
      timestamp: Date.now(),
    };
    desc.signature = await signDescriptor(this.identity.privateKeyPem, desc);
    return desc;
  }

  async setPhoneRelayMode(enabled) {
    this.phoneRelayMode = Boolean(enabled);
    localStorage.setItem('p2psecure.phoneRelayMode', String(this.phoneRelayMode));
    this.#log(
      this.phoneRelayMode
        ? 'نقش رله مش (P2P Mesh Relay) فعال شد: نگهداری و بازپخش امن پیام‌های رمزگذاری‌شده.'
        : 'نقش رله مش برای این دستگاه غیرفعال شد.',
    );
    await this.updateConnectionDetails({});
  }

  getRelayUrls() {
    return Array.from(new Set([...this.relayUrls, ...this.signaling.baseUrls]));
  }

  async addRelay(url) {
    if (!url) return false;
    const clean = url.trim().replace(/\/+$/, '');
    if (!clean) return false;
    if (!this.relayUrls.includes(clean)) {
      this.relayUrls.push(clean);
    }
    this.signaling.addDiscoveredRelays([clean]);
    await serviceStore.put({ url: clean, addedManually: true, discoveredAt: Date.now() });
    await this.updateConnectionDetails({ relayUrls: this.relayUrls });
    this.#log(`رله جدید افزوده شد: ${clean}`);
    return true;
  }

  async removeRelay(url) {
    if (!url) return;
    const clean = url.trim().replace(/\/+$/, '');
    this.relayUrls = this.relayUrls.filter((u) => u !== clean);
    if (this.relayUrls.length === 0) {
      this.relayUrls = [window.location.origin];
    }
    this.signaling.removeRelay(clean);
    await serviceStore.delete(clean);
    await this.updateConnectionDetails({ relayUrls: this.relayUrls });
    this.#log(`رله حذف شد: ${clean}`);
  }

  /** Pings all relays concurrently with timeout, preventing UI freeze */
  async getRelaysWithStatus() {
    const allUrls = this.getRelayUrls();
    const promises = allUrls.map(async (u) => {
      const ping = await this.signaling.pingRelay(u);
      return {
        url: u,
        isDefault: u === window.location.origin,
        isConfigured: this.relayUrls.includes(u),
        online: ping.ok,
        latencyMs: ping.latencyMs,
      };
    });
    return Promise.all(promises);
  }

  /**
   * Helper to decrypt, verify, and store zero-knowledge envelopes.
   */
  async #processReceivedEnvelopes(envelopes) {
    let accepted = 0;
    for (const envelope of envelopes) {
      try {
        const decryptedText = await decryptEnvelope(this.identity.privateKeyPem, envelope, null);
        const data = JSON.parse(decryptedText);
        if (!data || !data.senderId || !data.messageId) continue;
        if (!this.#remember(data.messageId)) continue;

        let sender = await peerStore.get(data.senderId);
        if (!sender && data.senderDescriptor) {
          const derived = await derivePeerId(data.senderDescriptor.publicKeyPem);
          if (derived === data.senderId) {
            sender = newPeerRecord(data.senderDescriptor, 'BLIND_MAILBOX');
            await peerStore.put(sender);
          }
        }
        if (!sender) continue;

        if (envelope.signature) {
          const validSig = await verifySignature(
            sender.publicKeyPem,
            [envelope.iv, envelope.ciphertext],
            envelope.signature,
          );
          if (!validSig) {
            this.#log(`رد بسته رله: امضای دیجیتال فرستنده نامعتبر است`);
            continue;
          }
        }

        if (data.block) {
          const check = await validateBlock(data.block, sender.publicKeyPem);
          if (!check.valid) {
            this.#log(`خطای بلاک رله: ${check.reason}`);
            continue;
          }
          await ledgerStore.put(data.block);
        }

        await messageStore.put({
          messageId: data.messageId,
          blockHash: data.block ? data.block.blockHash : null,
          index: data.block ? data.block.index : null,
          previousHash: data.block ? data.block.previousHash : null,
          senderId: data.senderId,
          recipientId: this.identity.peerId,
          isPublic: false,
          hopCount: 0,
          ttl: DEFAULT_TTL,
          payload: data.payload,
          signature: data.signature,
          status: 'DELIVERED',
          viaBlindMailbox: true,
          createdAt: data.block ? data.block.timestamp : Date.now(),
          deliveredAt: Date.now(),
        });

        accepted += 1;
        this.#log(
          `پیام با رمزنگاری صفر-دانش دریافت شد (از ${data.senderId.slice(0, 8)}). بسته از روی سرور سوخته و حذف گردید.`,
        );
      } catch (innerErr) {
        console.warn('Error processing decrypted blind mailbox envelope:', innerErr);
      }
    }

    if (accepted > 0) {
      this.#emitChange();
    }
    return accepted;
  }

  /**
   * Drain and burn zero-knowledge blind mailbox envelopes stored on relays
   * or via an active Internet Gateway peer in the local mesh.
   */
  async drainMyBlindMailbox() {
    try {
      const myToken = await deriveMailboxToken(this.identity.peerId);

      // 1. Direct internet drainage from cloud relays
      if (this.isInternetGateway || navigator.onLine) {
        const envelopes = await this.signaling.drainBlindMailbox(myToken);
        if (envelopes && envelopes.length > 0) {
          return await this.#processReceivedEnvelopes(envelopes);
        }
      }

      // 2. Mesh Gateway Bridge: If we are offline from internet, request any connected gateway peer to drain for us!
      const connectedGateways = Array.from(this.knownGateways).filter((id) => this.webrtc.isConnected(id));
      for (const gatewayId of connectedGateways) {
        this.webrtc.send(gatewayId, {
          type: 'GATEWAY_DRAIN_REQUEST',
          senderId: this.identity.peerId,
          token: myToken,
        });
      }

      return 0;
    } catch (err) {
      console.warn('drainMyBlindMailbox error:', err);
      return 0;
    }
  }

  /**
   * Update local connection details (new relays or alias), increment sequence,
   * sign descriptor, and broadcast to the mesh so all peers sync the new info!
   */
  async updateConnectionDetails({ relayUrls = null, alias = null }) {
    this.sequence += 1;
    localStorage.setItem('p2psecure.descriptorSeq', String(this.sequence));

    if (relayUrls !== null) {
      const raw = typeof relayUrls === 'string' ? relayUrls.split(/[,\s]+/) : relayUrls;
      this.relayUrls = raw.map((u) => u.trim()).filter(Boolean);
      this.signaling.addDiscoveredRelays(this.relayUrls);
    }

    if (alias !== null) {
      this.alias = alias.trim();
      localStorage.setItem('p2psecure.userAlias', this.alias);
    }

    const descriptor = await this.buildDescriptor();
    this.#log(`مشخصات اتصال محلی به نسخه v${this.sequence} ارتقا یافت و در مش منتشر شد.`);

    // Broadcast immediate descriptor update to all connected peers
    const packet = {
      type: 'DESCRIPTOR_UPDATE',
      senderId: this.identity.peerId,
      descriptor,
      relays: this.signaling.baseUrls,
    };
    this.webrtc.broadcast(packet);

    this.#emitChange();
    return descriptor;
  }

  buildInvite() {
    return JSON.stringify({
      v: 2,
      peerId: this.identity.peerId,
      publicKeyPem: this.identity.publicKeyPem,
      sequence: this.sequence,
      relayUrls: this.relayUrls,
      alias: this.alias,
    });
  }

  async acceptInvite(rawInvite) {
    const invite = JSON.parse(rawInvite);
    if (!invite.peerId || !invite.publicKeyPem) throw new Error('فیلدهای دعوت ناقص است');
    const derived = await derivePeerId(invite.publicKeyPem);
    if (derived !== invite.peerId) throw new Error('شناسه همتا با کلید عمومی همخوانی ندارد');
    if (invite.peerId === this.identity.peerId) throw new Error('این کد متعلق به خود شماست');

    const existing = await peerStore.get(invite.peerId);
    const record = existing
      ? mergePeerRecord(existing, { ...invite, source: 'MANUAL_QR', nextRetryAt: 0 })
      : newPeerRecord(invite, 'MANUAL_QR');

    await peerStore.put(record);
    if (invite.relayUrls) {
      this.signaling.addDiscoveredRelays(invite.relayUrls);
    }

    this.#emitChange();
    await this.dialPeer(invite.peerId);
    return record;
  }

  async adoptDirectPeer(remotePeer, connection, channel) {
    const derived = await derivePeerId(remotePeer.publicKeyPem);
    if (derived !== remotePeer.peerId) throw new Error('کلید عمومی با شناسه همتا همخوانی ندارد');

    const existing = await peerStore.get(remotePeer.peerId);
    const record = existing
      ? { ...existing, publicKeyPem: remotePeer.publicKeyPem, source: 'AIR_GAP', status: 'CONNECTED', nextRetryAt: 0 }
      : newPeerRecord(remotePeer, 'AIR_GAP');
    record.status = 'CONNECTED';
    record.lastConnected = Date.now();
    record.lastSeen = Date.now();
    await peerStore.put(record);

    this.webrtc.adoptDirectSession(remotePeer.peerId, connection, channel);
    this.#log(`اتصال مستقیم بدون سرور برقرار شد با ${remotePeer.peerId.slice(0, 8)}`);
    await this.publishGossip(remotePeer.peerId);
    await this.flushPending();
    this.#emitChange();
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
      // Pass peer's advertised relays to WebRTC manager
      await this.webrtc.dial(peerId, peer.relayUrls);
    } catch (error) {
      await this.#markFailure(peerId);
      this.#log(`تلاش برای اتصال ناموفق بود ${peerId.slice(0, 8)}: ${error.message}`);
    }
  }

  async runReconnectPass() {
    const peers = await peerStore.all();
    for (const peer of selectReconnectCandidates(peers)) {
      if (this.webrtc.isBusy(peer.peerId)) continue;
      await peerStore.put({
        ...peer,
        status: 'CONNECTING',
        nextRetryAt: Date.now() + backoffDelay(peer.failureCount + 1),
      });
      this.webrtc.dial(peer.peerId, peer.relayUrls).catch(() => this.#markFailure(peer.peerId));
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
    this.#log(`متصل شد به ${peerId.slice(0, 8)}`);

    // Mobile Mesh Relay: flush any envelopes buffered for this peer while they were offline!
    if (this.phoneRelayMode) {
      try {
        const buffered = await mailboxQueueStore.all();
        for (const item of buffered) {
          if (item.recipientId === peerId && item.packet) {
            this.webrtc.send(peerId, item.packet);
            await mailboxQueueStore.delete(item.id);
            this.#log(`رله موبایل مش: پیام ذخیره شده ${item.id.slice(0, 8)} به همتای تازه متصل تحویل داده شد.`);
          }
        }
      } catch (err) {
        console.warn('Error flushing mobile relay mailboxQueueStore:', err);
      }
    }

    await this.publishGossip(peerId);
    await this.flushPending();
    this.#emitChange();
  }

  async #handleChannelClose(peerId) {
    this.#log(`قطع اتصال از ${peerId.slice(0, 8)}`);
    await this.#markFailure(peerId);
  }

  // -- gossip & decentralized service sync ------------------------------

  async publishGossip(targetPeerId = null) {
    const peers = await peerStore.all();
    const myDescriptor = await this.buildDescriptor();

    const peerDescriptors = peers.map((peer) => ({
      peerId: peer.peerId,
      publicKeyPem: peer.publicKeyPem,
      alias: peer.alias,
      sequence: peer.sequence,
      relayUrls: peer.relayUrls,
      descriptorSignature: peer.descriptorSignature,
    }));

    const packet = {
      type: 'PEER_EXCHANGE',
      senderId: this.identity.peerId,
      senderDescriptor: myDescriptor,
      peers: [myDescriptor, ...peerDescriptors],
      relays: this.signaling.baseUrls,
    };

    if (targetPeerId) this.webrtc.send(targetPeerId, packet);
    else this.webrtc.broadcast(packet);
  }

  async #handlePeerExchange(packet) {
    // 1. Sync discovered community relays / services
    if (Array.isArray(packet.relays) && packet.relays.length > 0) {
      const added = this.signaling.addDiscoveredRelays(packet.relays);
      if (added > 0) {
        this.#log(`سینک سرویس‌ها: ${added} رله جدید از مش کشف و ثبت شد.`);
        for (const url of packet.relays) {
          if (url) await serviceStore.put({ url, discoveredAt: Date.now() });
        }
      }
    }

    // 2. Sync peer connection descriptors
    let learned = 0;
    let updated = 0;

    for (const entry of packet.peers || []) {
      if (!entry.peerId || entry.peerId === this.identity.peerId) continue;
      if (!entry.publicKeyPem) continue;
      if ((await derivePeerId(entry.publicKeyPem)) !== entry.peerId) continue;

      // Verify descriptor signature if present
      if (entry.signature) {
        const sigValid = await verifyDescriptorSignature(entry.publicKeyPem, entry);
        if (!sigValid) {
          continue; // skip unverified forged descriptor
        }
      }

      const existing = await peerStore.get(entry.peerId);
      if (!existing) {
        learned += 1;
        await peerStore.put(newPeerRecord(entry, 'GOSSIP'));
      } else if ((entry.sequence || 0) > (existing.sequence || 0)) {
        updated += 1;
        const oldRelays = (existing.relayUrls || []).join(',');
        const newRelays = (entry.relayUrls || []).join(',');

        await peerStore.put(mergePeerRecord(existing, entry));

        if (oldRelays !== newRelays) {
          this.#log(`مشخصات اتصال ${entry.peerId.slice(0, 8)} از بقیه سینک شد (نسخه v${entry.sequence}). رله‌های جدید: ${newRelays || 'پیش‌فرض'}`);
          // Re-dial using the freshly synced relay endpoint if disconnected
          if (existing.status !== 'CONNECTED') {
            this.dialPeer(entry.peerId);
          }
        }
      }
    }

    // 3. Track internet gateway bridge peers
    if (packet.senderDescriptor && packet.senderId) {
      if (packet.senderDescriptor.isInternetGateway) {
        this.knownGateways.add(packet.senderId);
        // If we are offline, ask this newly discovered internet gateway to drain our mailbox!
        if (!this.isInternetGateway && !navigator.onLine) {
          this.drainMyBlindMailbox();
        }
      } else {
        this.knownGateways.delete(packet.senderId);
      }
    }

    if (learned > 0 || updated > 0) {
      if (learned > 0) this.#log(`همتا(های) جدید کشف شد: ${learned}`);
      this.#emitChange();
    }
  }

  async #handleDescriptorUpdate(packet) {
    const desc = packet.descriptor;
    if (!desc || !desc.peerId || desc.peerId === this.identity.peerId) return;

    const existing = await peerStore.get(desc.peerId);
    if (!existing) return;

    // Verify signature
    const valid = await verifyDescriptorSignature(existing.publicKeyPem, desc);
    if (!valid) {
      this.#log(`رد بروزرسانی مشخصات ${desc.peerId.slice(0, 8)}: امضای نامعتبر`);
      return;
    }

    if ((desc.sequence || 0) > (existing.sequence || 0)) {
      const merged = mergePeerRecord(existing, desc);
      await peerStore.put(merged);

      const relayText = (desc.relayUrls || []).join(', ');
      this.#log(`سینک مشخصات اتصال جدید برای ${desc.peerId.slice(0, 8)} (v${desc.sequence}). رله: ${relayText}`);

      // Re-gossip update to other neighbors
      this.webrtc.broadcast(packet, existing.peerId);

      // Attempt immediate reconnection to new relay if not connected
      if (existing.status !== 'CONNECTED') {
        this.dialPeer(desc.peerId);
      }
      this.#emitChange();
    }
  }

  // -- messaging & blockchain ledger -----------------------------------

  async sendMessage(recipientId, payload) {
    const isPublic = recipientId === PUBLIC_CHANNEL;
    const targetRecipient = isPublic ? PUBLIC_CHANNEL : recipientId;

    const block = await createBlock({
      identity: this.identity,
      recipientId: targetRecipient,
      payload,
    });

    const record = {
      messageId: block.messageId,
      blockHash: block.blockHash,
      index: block.index,
      previousHash: block.previousHash,
      senderId: this.identity.peerId,
      recipientId: targetRecipient,
      isPublic,
      hopCount: 0,
      ttl: DEFAULT_TTL,
      payload,
      signature: block.signature,
      status: 'PENDING',
      createdAt: block.timestamp,
      deliveredAt: isPublic ? block.timestamp : null,
    };
    await messageStore.put(record);
    this.seenMessageIds.add(block.messageId);

    const packet = {
      type: 'DATA_PAYLOAD',
      block,
      messageId: block.messageId,
      senderId: this.identity.peerId,
      recipientId: targetRecipient,
      ttl: DEFAULT_TTL,
      hopCount: 0,
      payload,
      signature: block.signature,
      isPublic,
    };

    const routed = this.#route(packet);
    let newStatus = isPublic ? 'DELIVERED' : (routed ? 'SENT' : 'PENDING');

    // If private message could not be delivered directly (peer offline),
    // deposit to zero-knowledge E2EE blind mailbox on relays directly or via mesh internet gateway!
    if (!isPublic && !routed) {
      const peer = await peerStore.get(targetRecipient);
      if (peer && peer.publicKeyPem) {
        try {
          const myDesc = await this.buildDescriptor();
          const mailboxToken = await deriveMailboxToken(targetRecipient);
          const plaintext = JSON.stringify({
            senderId: this.identity.peerId,
            recipientId: targetRecipient,
            messageId: block.messageId,
            payload,
            signature: block.signature,
            block,
            senderDescriptor: myDesc,
          });

          const envelope = await encryptEnvelope(
            peer.publicKeyPem,
            plaintext,
            this.identity.privateKeyPem,
          );

          const targetRelays = [
            ...(peer.relayUrls || []),
            ...this.relayUrls,
            ...this.signaling.baseUrls,
          ];

          if (this.isInternetGateway || navigator.onLine) {
            const deposited = await this.signaling.depositBlindMailbox(
              mailboxToken,
              envelope,
              targetRelays,
              true,
            );
            if (deposited) {
              newStatus = 'RELAY_DEPOSITED';
              this.#log(
                `همتا ${targetRecipient.slice(0, 8)} آفلاین است: پیام با رمزنگاری صفر-دانش (E2EE) به صندوق موقت رله سپرده شد و پس از خواندن سوزانده می‌شود.`,
              );
            }
          } else {
            // Find any connected local peer acting as Internet Gateway Bridge
            const connectedGatewayId = Array.from(this.knownGateways).find((id) => this.webrtc.isConnected(id));
            if (connectedGatewayId) {
              this.webrtc.send(connectedGatewayId, {
                type: 'GATEWAY_DEPOSIT_REQUEST',
                messageId: block.messageId,
                token: mailboxToken,
                envelope,
                targetRelays,
              });
              newStatus = 'SENT';
              this.#log(`پیام برای تحویل به رله ابری از طریق پل اینترنت همتا ${connectedGatewayId.slice(0, 8)} ارسال شد.`);
            }
          }

          // Buffer in local Mobile Mesh Relay queue as physical store-and-forward fallback
          await mailboxQueueStore.put({
            id: block.messageId,
            recipientId: targetRecipient,
            packet,
            createdAt: Date.now(),
          });
        } catch (err) {
          console.warn('Blind mailbox deposit failed:', err);
        }
      }
    }

    await messageStore.put({ ...record, status: newStatus });
    this.#emitChange();
    return record;
  }

  async flushPending() {
    const messages = await messageStore.all();
    for (const message of messages) {
      if ((message.status !== 'PENDING' && message.status !== 'RELAY_DEPOSITED') || message.senderId !== this.identity.peerId) continue;
      const routed = this.#route({
        type: 'DATA_PAYLOAD',
        messageId: message.messageId,
        senderId: message.senderId,
        recipientId: message.recipientId,
        ttl: DEFAULT_TTL,
        hopCount: 0,
        payload: message.payload,
        signature: message.signature,
        isPublic: Boolean(message.isPublic),
        block: {
          index: message.index,
          previousHash: message.previousHash,
          blockHash: message.blockHash,
          timestamp: message.createdAt,
          messageId: message.messageId,
          senderId: message.senderId,
          recipientId: message.recipientId,
          payload: message.payload,
          signature: message.signature,
        },
      });
      if (routed) {
        await messageStore.put({ ...message, status: 'SENT' });
      }
    }
    this.#emitChange();
  }

  #route(packet, exceptPeerId = null) {
    if (packet.recipientId === PUBLIC_CHANNEL || packet.isPublic) {
      return this.webrtc.broadcast(packet, exceptPeerId) > 0;
    }
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
    if (packet.type === 'DESCRIPTOR_UPDATE') return this.#handleDescriptorUpdate(packet);
    if (packet.type === 'DATA_PAYLOAD') return this.#handleDataPayload(fromPeerId, packet);
    if (packet.type === 'DELIVERY_ACK') return this.#handleAck(packet);
    if (packet.type === 'GATEWAY_DRAIN_REQUEST') return this.#handleGatewayDrainRequest(fromPeerId, packet);
    if (packet.type === 'GATEWAY_DRAIN_RESPONSE') return this.#handleGatewayDrainResponse(fromPeerId, packet);
    if (packet.type === 'GATEWAY_DEPOSIT_REQUEST') return this.#handleGatewayDepositRequest(fromPeerId, packet);
    if (packet.type === 'GATEWAY_DEPOSIT_ACK') return this.#handleGatewayDepositAck(packet);
    return undefined;
  }

  async #handleGatewayDrainRequest(fromPeerId, packet) {
    if (!this.isInternetGateway || !packet.token) return;
    try {
      const envelopes = await this.signaling.drainBlindMailbox(packet.token);
      if (envelopes && envelopes.length > 0) {
        this.webrtc.send(fromPeerId, {
          type: 'GATEWAY_DRAIN_RESPONSE',
          token: packet.token,
          envelopes,
        });
        this.#log(`پل اینترنت: ${envelopes.length} بسته از رله ابری دریافت و به همتای مش ${fromPeerId.slice(0, 8)} تحویل شد.`);
      }
    } catch (err) {
      console.warn('Gateway drain request failed:', err);
    }
  }

  async #handleGatewayDrainResponse(fromPeerId, packet) {
    if (Array.isArray(packet.envelopes) && packet.envelopes.length > 0) {
      this.#log(`دریافت ${packet.envelopes.length} بسته از طریق پل اینترنت همتا (${fromPeerId.slice(0, 8)})`);
      await this.#processReceivedEnvelopes(packet.envelopes);
    }
  }

  async #handleGatewayDepositRequest(fromPeerId, packet) {
    if (!this.isInternetGateway || !packet.token || !packet.envelope) return;
    try {
      const success = await this.signaling.depositBlindMailbox(
        packet.token,
        packet.envelope,
        packet.targetRelays,
        true,
      );
      this.webrtc.send(fromPeerId, {
        type: 'GATEWAY_DEPOSIT_ACK',
        messageId: packet.messageId,
        success,
      });
      if (success) {
        this.#log(`پل اینترنت: بسته همتای آفلاین محلی ${fromPeerId.slice(0, 8)} با موفقیت به رله‌های ابری ارسال شد.`);
      }
    } catch (err) {
      console.warn('Gateway deposit request failed:', err);
    }
  }

  async #handleGatewayDepositAck(packet) {
    if (packet.messageId && packet.success) {
      const msg = await messageStore.get(packet.messageId);
      if (msg) {
        await messageStore.put({ ...msg, status: 'RELAY_DEPOSITED' });
        this.#log(`پیام شما از طریق پل اینترنت همسایه در صندوق رله ابری سپرده شد.`);
        this.#emitChange();
      }
    }
  }

  async #handleDataPayload(fromPeerId, packet) {
    if (!this.#remember(packet.messageId)) return;

    const isPublic = packet.recipientId === PUBLIC_CHANNEL || packet.isPublic;

    // 1. PUBLIC Mesh Channel broadcast message
    if (isPublic) {
      const sender = await peerStore.get(packet.senderId);
      if (packet.block && sender) {
        const check = await validateBlock(packet.block, sender.publicKeyPem);
        if (!check.valid) {
          this.#log(`بلاک عمومی رد شد: ${check.reason}`);
          return;
        }
        await ledgerStore.put(packet.block);
      }

      await messageStore.put({
        messageId: packet.messageId,
        blockHash: packet.block ? packet.block.blockHash : null,
        index: packet.block ? packet.block.index : null,
        previousHash: packet.block ? packet.block.previousHash : null,
        senderId: packet.senderId,
        recipientId: PUBLIC_CHANNEL,
        isPublic: true,
        hopCount: packet.hopCount || 0,
        ttl: packet.ttl || 0,
        payload: packet.payload,
        signature: packet.signature,
        status: 'DELIVERED',
        createdAt: packet.block ? packet.block.timestamp : Date.now(),
        deliveredAt: Date.now(),
      });

      const ttl = (packet.ttl || 0) - 1;
      if (ttl > 0) {
        this.#route({ ...packet, ttl, hopCount: (packet.hopCount || 0) + 1 }, fromPeerId);
      }
      this.#log(`پیام عمومی از ${packet.senderId.slice(0, 8)}`);
      this.#emitChange();
      return;
    }

    // 2. Relay packet if recipient is someone else in the mesh
    if (packet.recipientId !== this.identity.peerId) {
      const ttl = (packet.ttl || 0) - 1;
      if (ttl <= 0) return;
      const forwarded = this.#route({ ...packet, ttl, hopCount: (packet.hopCount || 0) + 1 }, fromPeerId);
      if (forwarded) {
        this.#log(`رله شد: ${packet.messageId.slice(0, 8)} (ttl ${ttl})`);
      } else if (this.phoneRelayMode) {
        // Recipient is not reachable in our current mesh: buffer on phone as Mobile Mesh Relay!
        await mailboxQueueStore.put({
          id: packet.messageId,
          recipientId: packet.recipientId,
          packet,
          createdAt: Date.now(),
        });
        this.#log(`گوشی در نقش رله: پیام ${packet.messageId.slice(0, 8)} برای همتای آفلاین بافر شد.`);
      }
      return;
    }

    // 3. Private message targeted directly to this node
    const sender = await peerStore.get(packet.senderId);
    let valid = false;
    if (packet.block && sender) {
      const check = await validateBlock(packet.block, sender.publicKeyPem);
      valid = check.valid;
      if (valid) {
        await ledgerStore.put(packet.block);
      } else {
        this.#log(`خطای بلاک: ${check.reason}`);
      }
    } else if (sender) {
      valid = await verifySignature(
        sender.publicKeyPem,
        [packet.messageId, packet.senderId, packet.recipientId, packet.payload],
        packet.signature,
      );
    }

    if (!valid) {
      this.#log(`رد پیام ${packet.messageId.slice(0, 8)}: امضا یا بلاک نامعتبر`);
      return;
    }

    await messageStore.put({
      messageId: packet.messageId,
      blockHash: packet.block ? packet.block.blockHash : null,
      index: packet.block ? packet.block.index : null,
      previousHash: packet.block ? packet.block.previousHash : null,
      senderId: packet.senderId,
      recipientId: packet.recipientId,
      isPublic: false,
      hopCount: packet.hopCount || 0,
      ttl: packet.ttl || 0,
      payload: packet.payload,
      signature: packet.signature,
      status: 'DELIVERED',
      createdAt: packet.block ? packet.block.timestamp : Date.now(),
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
    this.#log(`پیام تحویل گرفته شد از ${packet.senderId.slice(0, 8)}`);
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
    this.#log(`تایید تحویل (ACK) برای ${packet.messageId.slice(0, 8)}`);
    this.#emitChange();
  }
}
