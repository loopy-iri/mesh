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
