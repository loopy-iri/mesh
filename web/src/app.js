/** UI controller: binds the DOM to a MeshNode instance. */

import { generateIdentity } from './crypto.js';
import { identityStore, messageStore, peerStore, wipeEverything } from './db.js';
import { MeshNode } from './mesh.js';
import { renderQrToCanvas } from './qr.js';
import { isScannerSupported, QrScanner } from './scanner.js';

const RELAY_STORAGE_KEY = 'p2psecure.relayUrl';
const $ = (id) => document.getElementById(id);

let node = null;
let scanner = null;
const logLines = [];

function relayUrl() {
  return localStorage.getItem(RELAY_STORAGE_KEY) || window.location.origin;
}

function appendLog(text) {
  logLines.unshift(`${new Date().toLocaleTimeString('fa-IR')} — ${text}`);
  logLines.length = Math.min(logLines.length, 200);
  $('log-output').textContent = logLines.join('\n');
}

function shorten(peerId) {
  return `${peerId.slice(0, 10)}…`;
}

async function loadIdentity() {
  const existing = await identityStore.get();
  if (existing) return existing;
  const identity = await generateIdentity();
  await identityStore.put(identity);
  return identity;
}

function renderInvite() {
  const invite = node.buildInvite();
  $('invite-text').value = invite;
  try {
    renderQrToCanvas($('invite-qr'), invite, { scale: 5 });
  } catch (error) {
    appendLog(`تولید QR ناموفق بود: ${error.message}`);
  }
}

async function renderPeers() {
  const peers = (await peerStore.all()).sort((left, right) => right.lastSeen - left.lastSeen);
  const list = $('peer-list');
  list.textContent = '';
  const select = $('message-recipient');
  const previous = select.value;
  select.textContent = '';

  for (const peer of peers) {
    const item = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'mono';
    title.textContent = peer.alias ? `${peer.alias} (${shorten(peer.peerId)})` : shorten(peer.peerId);
    const meta = document.createElement('span');
    meta.className = `meta status-${peer.status}`;
    const source = peer.source === 'MANUAL_QR' ? 'اسکن دستی' : 'کشف با gossip';
    meta.textContent = `${peer.status} · ${source} · seq ${peer.sequence} · خطاها ${peer.failureCount}`;
    item.append(title, meta);
    list.append(item);

    const option = document.createElement('option');
    option.value = peer.peerId;
    option.textContent = `${shorten(peer.peerId)} (${peer.status})`;
    select.append(option);
  }
  if (previous) select.value = previous;

  const connected = peers.filter((peer) => peer.status === 'CONNECTED').length;
  $('connection-summary').textContent = `${connected} متصل از ${peers.length} همتا`;
}

async function renderMessages() {
  const messages = (await messageStore.all()).sort((left, right) => right.createdAt - left.createdAt);
  const list = $('message-list');
  list.textContent = '';
  for (const message of messages) {
    const item = document.createElement('li');
    const body = document.createElement('span');
    body.textContent = message.payload;
    const meta = document.createElement('span');
    meta.className = `meta status-${message.status}`;
    const direction =
      message.senderId === node.identity.peerId
        ? `به ${shorten(message.recipientId)}`
        : `از ${shorten(message.senderId)}`;
    meta.textContent = `${direction} · ${message.status} · hop ${message.hopCount}`;
    item.append(body, meta);
    list.append(item);
  }
}

async function refresh() {
  await Promise.all([renderPeers(), renderMessages()]);
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((other) => other.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
      tab.classList.add('active');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function bindIdentityControls() {
  $('relay-url').value = relayUrl();

  $('save-relay').addEventListener('click', () => {
    const value = $('relay-url').value.trim();
    if (!value) return;
    localStorage.setItem(RELAY_STORAGE_KEY, value);
    window.location.reload();
  });

  $('regenerate-identity').addEventListener('click', async () => {
    if (!window.confirm('هویت، همتاها و پیام‌ها پاک می‌شوند. ادامه می‌دهید؟')) return;
    node.stop();
    await wipeEverything();
    window.location.reload();
  });

  $('copy-invite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('invite-text').value);
      appendLog('متن دعوت کپی شد.');
    } catch (error) {
      $('invite-text').select();
    }
  });
}

async function addPeerFromInvite(raw) {
  try {
    const peer = await node.acceptInvite(raw.trim());
    appendLog(`همتا افزوده شد: ${shorten(peer.peerId)}`);
    $('paste-invite').value = '';
    await refresh();
  } catch (error) {
    appendLog(`دعوت نامعتبر: ${error.message}`);
  }
}

function bindPeerControls() {
  $('add-peer').addEventListener('click', () => addPeerFromInvite($('paste-invite').value));

  if (!isScannerSupported()) {
    $('start-scan').disabled = true;
    $('scanner-note').textContent = 'مرورگر شما اسکن داخلی را پشتیبانی نمی‌کند؛ متن دعوت را بچسبانید.';
    return;
  }

  $('start-scan').addEventListener('click', async () => {
    const video = $('scanner-video');
    video.hidden = false;
    $('stop-scan').hidden = false;
    scanner = new QrScanner(video, async (value) => {
      scanner.stop();
      video.hidden = true;
      $('stop-scan').hidden = true;
      await addPeerFromInvite(value);
    });
    try {
      await scanner.start();
    } catch (error) {
      $('scanner-note').textContent = `دوربین در دسترس نیست: ${error.message}`;
      video.hidden = true;
      $('stop-scan').hidden = true;
    }
  });

  $('stop-scan').addEventListener('click', () => {
    scanner?.stop();
    $('scanner-video').hidden = true;
    $('stop-scan').hidden = true;
  });
}

function bindMessageControls() {
  $('send-message').addEventListener('click', async () => {
    const recipientId = $('message-recipient').value;
    const payload = $('message-body').value.trim();
    if (!recipientId || !payload) return;
    await node.sendMessage(recipientId, payload);
    $('message-body').value = '';
    await refresh();
  });
}

async function main() {
  bindTabs();
  const identity = await loadIdentity();
  $('self-peer-id').textContent = identity.peerId;

  node = new MeshNode(identity, relayUrl());
  node.addEventListener('log', (event) => appendLog(event.detail));
  node.addEventListener('change', () => refresh());

  bindIdentityControls();
  bindPeerControls();
  bindMessageControls();
  renderInvite();

  await node.start();
  await refresh();
  appendLog(`آماده. رله: ${relayUrl()}`);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

main().catch((error) => appendLog(`خطای راه‌اندازی: ${error.message}`));
