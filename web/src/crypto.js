/**
 * Identity + signing primitives built on Web Crypto (ECDSA P-256 / SHA-256).
 * Keys are stored as PEM text so they can travel inside a QR invite.
 */

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS = { name: 'ECDSA', hash: { name: 'SHA-256' } };

const encoder = new TextEncoder();

function bytesToBase64(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index]);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toPem(base64, label) {
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

function fromPem(pem) {
  return base64ToBytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
}

export function base64UrlEncode(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** peerId is the base64url SHA-256 digest of the exported public key. */
export async function derivePeerId(publicKeyPem) {
  const digest = await crypto.subtle.digest('SHA-256', fromPem(publicKeyPem));
  return base64UrlEncode(digest);
}

export async function generateIdentity() {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const publicKeyPem = toPem(bytesToBase64(spki), 'PUBLIC KEY');
  const privateKeyPem = toPem(bytesToBase64(pkcs8), 'PRIVATE KEY');
  return {
    peerId: await derivePeerId(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    createdAt: Date.now(),
  };
}

export function importPrivateKey(privateKeyPem) {
  return crypto.subtle.importKey('pkcs8', fromPem(privateKeyPem), ALGORITHM, false, ['sign']);
}

export function importPublicKey(publicKeyPem) {
  return crypto.subtle.importKey('spki', fromPem(publicKeyPem), ALGORITHM, false, ['verify']);
}

/**
 * Canonical signing input: field values joined by a separator that cannot
 * appear in an id, so distinct payloads never collide.
 */
export function canonicalize(fields) {
  return fields.map((field) => String(field)).join('\u0000');
}

export async function signData(privateKeyPem, fields) {
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(SIGN_PARAMS, key, encoder.encode(canonicalize(fields)));
  return bytesToBase64(signature);
}

export async function verifySignature(publicKeyPem, fields, signatureBase64) {
  try {
    const key = await importPublicKey(publicKeyPem);
    return await crypto.subtle.verify(
      SIGN_PARAMS,
      key,
      base64ToBytes(signatureBase64),
      encoder.encode(canonicalize(fields)),
    );
  } catch (error) {
    return false;
  }
}

export function randomId() {
  return crypto.randomUUID();
}

/** Computes hex-encoded SHA-256 hash. */
export async function sha256Hex(textOrBytes) {
  const bytes = typeof textOrBytes === 'string' ? encoder.encode(textOrBytes) : textOrBytes;
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compress string for compact QR code representation. */
export async function compressString(str) {
  try {
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([new TextEncoder().encode(str)]).stream();
      const compressedStream = stream.pipeThrough(new CompressionStream('deflate-raw'));
      const buffer = await new Response(compressedStream).arrayBuffer();
      return bytesToBase64(buffer);
    }
  } catch (err) {
    /* fallback to uncompressed */
  }
  return btoa(unescape(encodeURIComponent(str)));
}

/** Decompress string from compact QR code representation. */
export async function decompressString(base64) {
  try {
    if (typeof DecompressionStream !== 'undefined') {
      const bytes = base64ToBytes(base64);
      const stream = new Blob([bytes]).stream();
      const decompressedStream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
      const buffer = await new Response(decompressedStream).arrayBuffer();
      return new TextDecoder().decode(buffer);
    }
  } catch (err) {
    /* fallback to uncompressed */
  }
  return decodeURIComponent(escape(atob(base64)));
}

/** Canonical fields for signing a peer connection descriptor. */
export function descriptorFields(desc) {
  const relayStr = Array.isArray(desc.relayUrls) ? desc.relayUrls.join(',') : (desc.relayUrls || '');
  return [
    desc.peerId,
    desc.sequence || 1,
    relayStr,
    desc.alias || '',
    desc.timestamp || 0,
  ];
}

/** Signs a peer connection descriptor with the peer's private key. */
export async function signDescriptor(privateKeyPem, descriptor) {
  return signData(privateKeyPem, descriptorFields(descriptor));
}

/** Verifies a peer connection descriptor against the peer's public key. */
export async function verifyDescriptorSignature(publicKeyPem, descriptor) {
  if (!descriptor || !descriptor.signature) return false;
  return verifySignature(publicKeyPem, descriptorFields(descriptor), descriptor.signature);
}

/**
 * Derives a blind, zero-knowledge mailbox token for storing offline envelopes.
 * The relay sees only this cryptographic hash and has no knowledge of peerId.
 */
export async function deriveMailboxToken(peerId) {
  return sha256Hex(`BLIND_MBX:${peerId}`);
}

/**
 * End-to-End Encrypt (E2EE) a payload using ephemeral ECDH + AES-GCM-256.
 * Guarantees that only the holder of recipientPrivateKeyPem can decrypt,
 * and relays or intermediaries see only opaque ciphertext.
 */
export async function encryptEnvelope(recipientPublicKeyPem, plaintext, senderPrivateKeyPem = null) {
  // 1. Generate ephemeral ECDH keypair
  const ephem = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey'],
  );
  const ephemSpki = await crypto.subtle.exportKey('spki', ephem.publicKey);
  const ephemPublicKeyPem = toPem(bytesToBase64(ephemSpki), 'PUBLIC KEY');

  // 2. Import recipient's public key as ECDH
  const recipientEcdhPub = await crypto.subtle.importKey(
    'spki',
    fromPem(recipientPublicKeyPem),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // 3. Derive 256-bit AES-GCM symmetric key
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: recipientEcdhPub },
    ephem.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );

  // 4. Encrypt plaintext
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encodedPlaintext = encoder.encode(plaintext);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sharedKey,
    encodedPlaintext,
  );

  const ivBase64 = bytesToBase64(iv);
  const ciphertextBase64 = bytesToBase64(ciphertextBuffer);

  // 5. Optional sender signature over ciphertext for authentication
  let signature = null;
  if (senderPrivateKeyPem) {
    signature = await signData(senderPrivateKeyPem, [ivBase64, ciphertextBase64]);
  }

  return {
    ephemPublicKeyPem,
    iv: ivBase64,
    ciphertext: ciphertextBase64,
    signature,
    timestamp: Date.now(),
  };
}

/**
 * Decrypt an E2EE envelope using the recipient's private key.
 */
export async function decryptEnvelope(recipientPrivateKeyPem, envelope, senderPublicKeyPem = null) {
  if (!envelope || !envelope.ephemPublicKeyPem || !envelope.iv || !envelope.ciphertext) {
    throw new Error('ساختار بسته رمزنگاری‌شده ناقص است');
  }

  // 1. Verify sender signature if provided
  if (senderPublicKeyPem && envelope.signature) {
    const valid = await verifySignature(
      senderPublicKeyPem,
      [envelope.iv, envelope.ciphertext],
      envelope.signature,
    );
    if (!valid) throw new Error('امضای دیجیتال بسته رمزنگاری‌شده نامعتبر است');
  }

  // 2. Import ephemeral public key
  const ephemPub = await crypto.subtle.importKey(
    'spki',
    fromPem(envelope.ephemPublicKeyPem),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // 3. Import recipient's private key as ECDH
  const recipientEcdhPriv = await crypto.subtle.importKey(
    'pkcs8',
    fromPem(recipientPrivateKeyPem),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey'],
  );

  // 4. Derive the matching 256-bit AES-GCM key
  const sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: ephemPub },
    recipientEcdhPriv,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  // 5. Decrypt ciphertext
  const ivBytes = base64ToBytes(envelope.iv);
  const ciphertextBytes = base64ToBytes(envelope.ciphertext);
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    sharedKey,
    ciphertextBytes,
  );

  return new TextDecoder().decode(decryptedBuffer);
}


