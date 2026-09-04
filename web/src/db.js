/**
 * Minimal promise wrapper over IndexedDB.
 * Stores:
 * - identity: single local identity
 * - peers: known mesh peers keyed by peerId
 * - messages: chat messages keyed by messageId
 * - ledger: immutable blockchain blocks keyed by blockHash
 * - services: known signaling relays & network services keyed by url
 * - mailboxQueue: buffered encrypted blind envelopes when acting as a mobile mesh relay
 */

const DB_NAME = 'p2psecure';
const DB_VERSION = 4;
const IDENTITY_KEY = 'local';

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains('identity')) {
        db.createObjectStore('identity');
      }
      if (!db.objectStoreNames.contains('peers')) {
        db.createObjectStore('peers', { keyPath: 'peerId' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const messages = db.createObjectStore('messages', { keyPath: 'messageId' });
        messages.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('ledger')) {
        const ledger = db.createObjectStore('ledger', { keyPath: 'blockHash' });
        ledger.createIndex('index', 'index');
        ledger.createIndex('timestamp', 'timestamp');
        ledger.createIndex('senderId', 'senderId');
        ledger.createIndex('recipientId', 'recipientId');
      }
      if (!db.objectStoreNames.contains('services')) {
        db.createObjectStore('services', { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains('mailboxQueue')) {
        const q = db.createObjectStore('mailboxQueue', { keyPath: 'id' });
        q.createIndex('recipientId', 'recipientId');
        q.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(storeName, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
    if (request) {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } else {
      tx.oncomplete = () => resolve(undefined);
    }
  });
}

export const identityStore = {
  get: () => run('identity', 'readonly', (store) => store.get(IDENTITY_KEY)),
  put: (identity) => run('identity', 'readwrite', (store) => store.put(identity, IDENTITY_KEY)),
  clear: () => run('identity', 'readwrite', (store) => store.delete(IDENTITY_KEY)),
};

export const peerStore = {
  get: (peerId) => run('peers', 'readonly', (store) => store.get(peerId)),
  all: () => run('peers', 'readonly', (store) => store.getAll()),
  put: (peer) => run('peers', 'readwrite', (store) => store.put(peer)),
  delete: (peerId) => run('peers', 'readwrite', (store) => store.delete(peerId)),
  clear: () => run('peers', 'readwrite', (store) => store.clear()),
};

export const messageStore = {
  get: (messageId) => run('messages', 'readonly', (store) => store.get(messageId)),
  all: () => run('messages', 'readonly', (store) => store.getAll()),
  put: (message) => run('messages', 'readwrite', (store) => store.put(message)),
  clear: () => run('messages', 'readwrite', (store) => store.clear()),
};

export const ledgerStore = {
  get: (blockHash) => run('ledger', 'readonly', (store) => store.get(blockHash)),
  all: () => run('ledger', 'readonly', (store) => store.getAll()),
  put: (block) => run('ledger', 'readwrite', (store) => store.put(block)),
  clear: () => run('ledger', 'readwrite', (store) => store.clear()),
};

export const serviceStore = {
  get: (url) => run('services', 'readonly', (store) => store.get(url)),
  all: () => run('services', 'readonly', (store) => store.getAll()),
  put: (service) => run('services', 'readwrite', (store) => store.put(service)),
  delete: (url) => run('services', 'readwrite', (store) => store.delete(url)),
  clear: () => run('services', 'readwrite', (store) => store.clear()),
};

export const mailboxQueueStore = {
  get: (id) => run('mailboxQueue', 'readonly', (store) => store.get(id)),
  all: () => run('mailboxQueue', 'readonly', (store) => store.getAll()),
  put: (item) => run('mailboxQueue', 'readwrite', (store) => store.put(item)),
  delete: (id) => run('mailboxQueue', 'readwrite', (store) => store.delete(id)),
  clear: () => run('mailboxQueue', 'readwrite', (store) => store.clear()),
};

export async function wipeEverything() {
  await Promise.all([
    identityStore.clear(),
    peerStore.clear(),
    messageStore.clear(),
    ledgerStore.clear(),
    serviceStore.clear(),
    mailboxQueueStore.clear(),
  ]);
}
