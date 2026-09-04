/**
 * Manages one RTCPeerConnection + `mesh-data` DataChannel per remote peer.
 * Glare is resolved with the perfect-negotiation "polite peer" rule: the peer
 * with the lexicographically smaller peerId is polite and yields on collision.
 */

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export class WebRtcManager {
  constructor({ selfId, signaling, onChannelOpen, onChannelClose, onMessage }) {
    this.selfId = selfId;
    this.signaling = signaling;
    this.onChannelOpen = onChannelOpen;
    this.onChannelClose = onChannelClose;
    this.onMessage = onMessage;
    this.sessions = new Map();
  }

  connectedPeerIds() {
    return [...this.sessions.entries()]
      .filter(([, session]) => session.channel && session.channel.readyState === 'open')
      .map(([peerId]) => peerId);
  }

  isConnected(peerId) {
    const session = this.sessions.get(peerId);
    return Boolean(session && session.channel && session.channel.readyState === 'open');
  }

  isBusy(peerId) {
    const session = this.sessions.get(peerId);
    if (!session) return false;
    const state = session.connection.connectionState;
    return state === 'new' || state === 'connecting' || this.isConnected(peerId);
  }

  send(peerId, packet) {
    const session = this.sessions.get(peerId);
    if (!session || !session.channel || session.channel.readyState !== 'open') return false;
    session.channel.send(JSON.stringify(packet));
    return true;
  }

  broadcast(packet, exceptPeerId = null) {
    let delivered = 0;
    for (const peerId of this.connectedPeerIds()) {
      if (peerId === exceptPeerId) continue;
      if (this.send(peerId, packet)) delivered += 1;
    }
    return delivered;
  }

  close(peerId) {
    const session = this.sessions.get(peerId);
    if (!session) return;
    this.sessions.delete(peerId);
    try {
      session.connection.close();
    } catch (error) {
      /* already closed */
    }
  }

  closeAll() {
    for (const peerId of [...this.sessions.keys()]) this.close(peerId);
  }

  /**
   * Adopt an existing connection/channel established via direct air-gap / offline handshake.
   */
  adoptDirectSession(peerId, connection, channel) {
    this.close(peerId);
    const session = {
      connection,
      channel,
      polite: this.selfId < peerId,
      makingOffer: false,
      ignoreOffer: false,
    };
    this.sessions.set(peerId, session);

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.sessions.delete(peerId);
        try {
          connection.close();
        } catch (error) {
          /* ignore */
        }
        this.onChannelClose?.(peerId);
      }
    };

    this.#bindChannel(peerId, session, channel);
    if (channel.readyState === 'open') {
      this.onChannelOpen?.(peerId);
    }
  }

  #session(peerId) {
    const existing = this.sessions.get(peerId);
    if (existing) return existing;

    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const session = {
      connection,
      channel: null,
      polite: this.selfId < peerId,
      makingOffer: false,
      ignoreOffer: false,
    };
    this.sessions.set(peerId, session);

    connection.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this.signaling
        .send(peerId, { kind: 'ice', candidate: candidate.toJSON() })
        .catch(() => {});
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.sessions.delete(peerId);
        try {
          connection.close();
        } catch (error) {
          /* ignore */
        }
        this.onChannelClose?.(peerId);
      }
    };

    connection.ondatachannel = ({ channel }) => this.#bindChannel(peerId, session, channel);
    return session;
  }

  #bindChannel(peerId, session, channel) {
    session.channel = channel;
    channel.onopen = () => this.onChannelOpen?.(peerId);
    channel.onclose = () => this.onChannelClose?.(peerId);
    channel.onmessage = (event) => {
      let packet;
      try {
        packet = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      this.onMessage?.(peerId, packet);
    };
  }

  /** Initiate (or re-initiate) an outbound connection to peerId. */
  async dial(peerId) {
    const session = this.#session(peerId);
    if (!session.channel) {
      this.#bindChannel(
        peerId,
        session,
        session.connection.createDataChannel('mesh-data', { ordered: true }),
      );
    }
    try {
      session.makingOffer = true;
      const offer = await session.connection.createOffer();
      await session.connection.setLocalDescription(offer);
      await this.signaling.send(peerId, {
        kind: 'sdp',
        description: session.connection.localDescription.toJSON(),
      });
    } finally {
      session.makingOffer = false;
    }
  }

  async handleSignal(peerId, signal) {
    const session = this.#session(peerId);
    const connection = session.connection;

    if (signal.kind === 'sdp') {
      const description = signal.description;
      const offerCollision =
        description.type === 'offer' &&
        (session.makingOffer || connection.signalingState !== 'stable');
      session.ignoreOffer = !session.polite && offerCollision;
      if (session.ignoreOffer) return;

      // Polite peer rolls back implicitly inside setRemoteDescription.
      await connection.setRemoteDescription(description);
      if (description.type === 'offer') {
        await connection.setLocalDescription(await connection.createAnswer());
        await this.signaling.send(peerId, {
          kind: 'sdp',
          description: connection.localDescription.toJSON(),
        });
      }
      return;
    }

    if (signal.kind === 'ice') {
      try {
        await connection.addIceCandidate(signal.candidate);
      } catch (error) {
        if (!session.ignoreOffer) throw error;
      }
    }
  }
}
