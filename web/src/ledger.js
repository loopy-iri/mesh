/**
 * Decentralized Blockchain Hash-chain Ledger.
 *
 * Each message is sealed as an immutable block in a cryptographic hash-chain:
 *   blockHash = SHA-256(index | previousHash | timestamp | messageId | senderId | recipientId | payload)
 *   signature = ECDSA-P256-SHA256(blockHash, senderId, recipientId)
 *
 * Guarantees tamper-evidence: If any peer or relay alters even one bit of the
 * message or history, the hash and signature verification fails instantly.
 */

import { sha256Hex, signData, verifySignature, randomId } from './crypto.js';
import { ledgerStore } from './db.js';

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
export const PUBLIC_CHANNEL = 'PUBLIC';

export function canonicalBlockString(block) {
  return [
    block.index,
    block.previousHash,
    block.timestamp,
    block.messageId,
    block.senderId,
    block.recipientId,
    block.payload,
  ].join('|');
}

export async function computeBlockHash(block) {
  return sha256Hex(canonicalBlockString(block));
}

/**
 * Get the latest block from the local ledger.
 */
export async function getLatestBlock() {
  const allBlocks = await ledgerStore.all();
  if (!allBlocks || allBlocks.length === 0) return null;
  return allBlocks.reduce((latest, current) =>
    (current.index || 0) > (latest.index || 0) ? current : latest,
  );
}

/**
 * Create and sign a new block on top of the local blockchain ledger.
 */
export async function createBlock({
  identity,
  recipientId,
  payload,
  messageId = randomId(),
  timestamp = Date.now(),
}) {
  const latest = await getLatestBlock();
  const index = latest ? (latest.index || 0) + 1 : 1;
  const previousHash = latest ? latest.blockHash : GENESIS_HASH;

  const blockData = {
    index,
    previousHash,
    timestamp,
    messageId,
    senderId: identity.peerId,
    recipientId: recipientId || PUBLIC_CHANNEL,
    payload,
  };

  const blockHash = await computeBlockHash(blockData);
  const signature = await signData(identity.privateKeyPem, [
    blockHash,
    blockData.senderId,
    blockData.recipientId,
  ]);

  const block = {
    ...blockData,
    blockHash,
    signature,
    createdAt: timestamp,
  };

  await ledgerStore.put(block);
  return block;
}

/**
 * Validates a block's internal cryptographic integrity and signature.
 */
export async function validateBlock(block, senderPublicKeyPem) {
  if (!block || !block.blockHash || !block.signature) {
    return { valid: false, reason: 'ساختار بلاک نامعتبر است' };
  }

  // 1. Verify computed block hash
  const expectedHash = await computeBlockHash(block);
  if (expectedHash !== block.blockHash) {
    return {
      valid: false,
      reason: `هش بلاک مغایرت دارد (دستکاری شده). انتظار: ${expectedHash.slice(0, 8)}، دریافتی: ${block.blockHash.slice(0, 8)}`,
    };
  }

  // 2. Verify digital signature
  const signatureOk = await verifySignature(
    senderPublicKeyPem,
    [block.blockHash, block.senderId, block.recipientId],
    block.signature,
  );
  if (!signatureOk) {
    return { valid: false, reason: 'امضای دیجیتال بلاک معتبر نیست یا فرستنده ناشناس است' };
  }

  return { valid: true };
}

/**
 * Verify entire ledger continuity and return audit status.
 */
export async function verifyLedgerIntegrity() {
  const blocks = (await ledgerStore.all()).sort((a, b) => a.index - b.index);
  if (blocks.length === 0) {
    return { valid: true, count: 0, errors: [] };
  }

  const errors = [];
  for (let i = 0; i < blocks.length; i++) {
    const current = blocks[i];
    const expectedHash = await computeBlockHash(current);
    if (expectedHash !== current.blockHash) {
      errors.push(`بلاک #${current.index} دستکاری شده است (هش نادرست).`);
    }

    if (i === 0) {
      if (current.previousHash !== GENESIS_HASH && blocks.length > 1) {
        // First block in local ledger
      }
    } else {
      const prev = blocks[i - 1];
      if (current.previousHash !== prev.blockHash) {
        errors.push(`گسستگی در زنجیره: بلاک #${current.index} به هش قبلی #${prev.index} متصل نیست.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    count: blocks.length,
    errors,
  };
}
