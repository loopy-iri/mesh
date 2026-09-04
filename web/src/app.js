/**
 * UI Controller for P2P Secure Mesh Messenger.
 *
 * Connects the DOM with:
 * - MeshNode (network engine & peer discovery)
 * - Decentralized Blockchain Ledger
 * - Serverless Air-Gapped Direct Connect
 * - Modern Interactive Chat Interface
 */

import { generateIdentity } from './crypto.js';
import { identityStore, messageStore, peerStore, ledgerStore, wipeEverything } from './db.js';
import { DirectConnectManager } from './direct-connect.js';
import { PUBLIC_CHANNEL, verifyLedgerIntegrity } from './ledger.js';
import { MeshNode } from './mesh.js';
import { renderQrToCanvas } from './qr.js';
import { isScannerSupported, QrScanner } from './scanner.js';

const RELAY_STORAGE_KEY = 'p2psecure.relayUrls';
const ALIAS_STORAGE_KEY = 'p2psecure.userAlias';
const $ = (id) => document.getElementById(id);

let node = null;
let scanner = null;
let directConnect = null;
let activeRecipientId = PUBLIC_CHANNEL;
const logLines = [];

function relayUrls() {
  return localStorage.getItem(RELAY_STORAGE_KEY) || window.location.origin;
}

function userAlias() {
  return localStorage.getItem(ALIAS_STORAGE_KEY) || '';
}

function shorten(peerId) {
  if (!peerId) return '—';
  if (peerId === PUBLIC_CHANNEL) return 'کانال عمومی مش';
  return `${peerId.slice(0, 8)}…`;
}

function appendLog(text) {
  const timestamp = new Date().toLocaleTimeString('fa-IR');
  logLines.unshift(`${timestamp} — ${text}`);
  logLines.length = Math.min(logLines.length, 250);
  const logEl = $('log-output');
  if (logEl) logEl.textContent = logLines.join('\n');
}

async function loadIdentity() {
  const existing = await identityStore.get();
  if (existing) return existing;
  const identity = await generateIdentity();
  await identityStore.put(identity);
  return identity;
}

/* ==========================================================================
   TABS & NAVIGATION
   ========================================================================== */
function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((other) => other.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
      tab.classList.add('active');
      const targetPanel = $(`tab-${tab.dataset.tab}`);
      if (targetPanel) targetPanel.classList.add('active');
    });
  });

  const guideGoBtn = $('guide-go-to-chat');
  if (guideGoBtn) {
    guideGoBtn.addEventListener('click', () => {
      const chatTab = document.querySelector('.tab[data-tab="chat"]');
      if (chatTab) chatTab.click();
    });
  }

  // Mobile conversation back button
  const backBtn = $('back-to-convs-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      const sidebar = document.querySelector('.chat-sidebar');
      if (sidebar) sidebar.classList.remove('hidden-mobile');
    });
  }
}

/* ==========================================================================
   CHAT SYSTEM
   ========================================================================== */
async function renderConversations() {
  const peers = await peerStore.all();
  const list = $('conversation-list');
  if (!list) return;
  list.innerHTML = '';

  const connectedCount = peers.filter((p) => p.status === 'CONNECTED').length;
  $('active-peers-count').textContent = `${connectedCount} متصل`;

  // 1. Public Channel item (Broadcast)
  const publicItem = document.createElement('li');
  publicItem.className = `conv-item ${activeRecipientId === PUBLIC_CHANNEL ? 'active' : ''}`;
  publicItem.innerHTML = `
    <div class="avatar online">📢</div>
    <div class="conv-info">
      <div class="conv-title">کانال همگانی مش</div>
      <div class="conv-snippet">ارسال به تمام نودهای در دسترس</div>
    </div>
  `;
  publicItem.addEventListener('click', () => selectConversation(PUBLIC_CHANNEL));
  list.appendChild(publicItem);

  // 2. Individual Peer conversations
  const sortedPeers = peers.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  for (const peer of sortedPeers) {
    const isConnected = peer.status === 'CONNECTED';
    const title = peer.alias ? `${peer.alias} (${shorten(peer.peerId)})` : shorten(peer.peerId);
    const item = document.createElement('li');
    item.className = `conv-item ${activeRecipientId === peer.peerId ? 'active' : ''}`;
    item.innerHTML = `
      <div class="avatar ${isConnected ? 'online' : ''}">👤</div>
      <div class="conv-info">
        <div class="conv-title">${title}</div>
        <div class="conv-snippet">${peer.status === 'CONNECTED' ? 'آنلاین در مش' : 'آفلاین'}</div>
      </div>
    `;
    item.addEventListener('click', () => selectConversation(peer.peerId));
    list.appendChild(item);
  }
}

async function selectConversation(recipientId) {
  activeRecipientId = recipientId;
  await renderConversations();
  await renderChatMessages();

  // On mobile, hide sidebar when conversation is picked
  const sidebar = document.querySelector('.chat-sidebar');
  if (sidebar && window.innerWidth <= 768) {
    sidebar.classList.add('hidden-mobile');
  }
}

async function renderChatMessages() {
  const isPublic = activeRecipientId === PUBLIC_CHANNEL;
  const myId = node.identity.peerId;

  // Header update
  if (isPublic) {
    $('current-chat-avatar').textContent = '📢';
    $('current-chat-title').textContent = 'کانال همگانی مش';
    $('current-chat-status').textContent = 'انتشار پیام در کل شبکه مش';
  } else {
    const peer = await peerStore.get(activeRecipientId);
    $('current-chat-avatar').textContent = '👤';
    $('current-chat-title').textContent = peer?.alias ? `${peer.alias} (${shorten(activeRecipientId)})` : shorten(activeRecipientId);
    $('current-chat-status').textContent = peer?.status === 'CONNECTED' ? 'متصل در مش' : 'قطع ارتباط (در انتظار رله)';
  }

  const allMessages = await messageStore.all();
  const relevant = allMessages.filter((msg) => {
    if (isPublic) {
      return msg.recipientId === PUBLIC_CHANNEL || msg.isPublic;
    }
    return (
      (msg.senderId === activeRecipientId && msg.recipientId === myId) ||
      (msg.senderId === myId && msg.recipientId === activeRecipientId)
    );
  }).sort((a, b) => a.createdAt - b.createdAt);

  const container = $('chat-messages');
  container.innerHTML = '';

  if (relevant.length === 0) {
    container.innerHTML = `
      <div class="chat-welcome">
        <p>هنوز پیامی در این گفتگو وجود ندارد. نخستین پیام مهر و موم شده را بفرستید!</p>
      </div>
    `;
    return;
  }

  for (const msg of relevant) {
    const isOut = msg.senderId === myId;
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${isOut ? 'message-outgoing' : 'message-incoming'}`;

    const senderHtml = (!isOut && isPublic)
      ? `<div class="message-sender">${shorten(msg.senderId)}</div>`
      : '';

    const timeStr = new Date(msg.createdAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

    let statusHtml = '';
    if (isOut) {
      if (msg.status === 'DELIVERED') {
        statusHtml = '<span class="msg-status-ok" title="تحویل داده شد">✓✓</span>';
      } else if (msg.status === 'SENT') {
        statusHtml = '<span class="msg-status-sent" title="ارسال شد">✓</span>';
      } else {
        statusHtml = '<span class="msg-status-pending" title="در صف ارسال">🕒</span>';
      }
    }

    const blockIndex = msg.index || 1;
    const blockBadge = msg.blockHash
      ? `<span class="block-tag" data-hash="${msg.blockHash}" title="مشاهده مشخصات بلاک در دفترکل">بلاک #${blockIndex} ⛓️</span>`
      : '';

    bubble.innerHTML = `
      ${senderHtml}
      <div class="message-text">${escapeHtml(msg.payload)}</div>
      <div class="message-footer">
        ${blockBadge}
        <span class="message-time">${timeStr}</span>
        ${statusHtml}
      </div>
    `;

    // Click on block badge opens modal
    const badgeEl = bubble.querySelector('.block-tag');
    if (badgeEl) {
      badgeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openBlockModal(msg);
      });
    }

    container.appendChild(bubble);
  }

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function bindChatControls() {
  const form = $('chat-form');
  const input = $('chat-input');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    try {
      await node.sendMessage(activeRecipientId, text);
      await renderChatMessages();
      await renderConversations();
    } catch (err) {
      appendLog(`خطای ارسال پیام: ${err.message}`);
    }
  });

  // Enter to send (Shift+Enter for newline)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  });

  // Quick reply chips
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      input.value = chip.dataset.text;
      input.focus();
    });
  });
}

/* ==========================================================================
   BLOCKCHAIN MODAL & AUDIT
   ========================================================================== */
async function openBlockModal(msg) {
  const block = (msg.blockHash ? await ledgerStore.get(msg.blockHash) : null) || {
    index: msg.index || 1,
    blockHash: msg.blockHash || '—',
    previousHash: msg.previousHash || '0000000000000000000000000000000000000000000000000000000000000000',
    senderId: msg.senderId,
    recipientId: msg.recipientId,
    signature: msg.signature,
    timestamp: msg.createdAt,
  };

  $('modal-block-index').textContent = `#${block.index}`;
  $('modal-block-hash').textContent = block.blockHash;
  $('modal-block-prev').textContent = block.previousHash || '—';
  $('modal-block-sender').textContent = block.senderId;
  $('modal-block-recipient').textContent = block.recipientId === PUBLIC_CHANNEL ? 'کانال عمومی (PUBLIC)' : block.recipientId;
  $('modal-block-sig').textContent = block.signature || '—';
  $('modal-block-time').textContent = new Date(block.timestamp).toLocaleString('fa-IR');

  $('block-modal').hidden = false;
}

function bindModalControls() {
  $('close-block-modal').addEventListener('click', () => {
    $('block-modal').hidden = true;
  });

  $('block-modal').addEventListener('click', (e) => {
    if (e.target === $('block-modal')) {
      $('block-modal').hidden = true;
    }
  });

  $('audit-ledger-btn').addEventListener('click', async () => {
    const resEl = $('ledger-audit-result');
    resEl.innerHTML = 'در حال محاسبه و بررسی امضاها و زنجیره هش‌ها…';
    const audit = await verifyLedgerIntegrity();
    if (audit.valid) {
      resEl.innerHTML = `<span class="status-ok">✓ زنجیره کاملاً سالم است. تعداد کل بلاک‌های ثبت‌شده: ${audit.count} بلاک. هیچ دستکاری در تاریخچه رخ نداده است.</span>`;
    } else {
      resEl.innerHTML = `<span style="color: #ef4444;">هشدار: ${audit.errors.join(' | ')}</span>`;
    }
  });
}

/* ==========================================================================
   AIR-GAPPED / SERVERLESS DIRECT CONNECT
   ========================================================================== */
function bindDirectConnectControls() {
  directConnect = new DirectConnectManager({
    identity: node.identity,
    onConnected: async (remotePeer, connection, channel) => {
      appendLog(`اتصال مستقیم بدون سرور برقرار شد با ${remotePeer.peerId.slice(0, 8)}`);
      await node.adoptDirectPeer(remotePeer, connection, channel);
      $('airgap-stage').hidden = true;
      await refreshAll();
    },
  });

  // Step 1: Device A creates Offer
  $('btn-airgap-create-offer').addEventListener('click', async () => {
    try {
      appendLog('در حال تولید بسته اتصال آفلاین (Offer)...');
      const offerCode = await directConnect.createOfferPackage();
      $('airgap-stage-title').textContent = 'گام اول: کد اتصال مستقیم (Offer)';
      $('airgap-stage-desc').textContent = 'گوشی دوم باید این کد را با دوربین اسکن کند تا اتصال بدون نیاز به سرور برقرار شود.';
      $('airgap-text').value = offerCode;
      renderQrToCanvas($('airgap-qr'), offerCode, { scale: 4 });
      $('airgap-stage').hidden = false;
    } catch (err) {
      appendLog(`خطای ایجاد کد آفلاین: ${err.message}`);
    }
  });

  // Camera scan button
  $('btn-airgap-scan').addEventListener('click', async () => {
    const video = $('scanner-video');
    video.hidden = false;
    $('stop-scan').hidden = false;
    scanner = new QrScanner(video, async (code) => {
      scanner.stop();
      video.hidden = true;
      $('stop-scan').hidden = true;
      await handleAirgapCode(code.trim());
    });
    try {
      await scanner.start();
    } catch (err) {
      appendLog(`خطای دوربین: ${err.message}`);
      video.hidden = true;
      $('stop-scan').hidden = true;
    }
  });

  // Manual code paste
  $('btn-airgap-apply').addEventListener('click', async () => {
    const code = $('airgap-paste-code').value.trim();
    if (!code) return;
    await handleAirgapCode(code);
    $('airgap-paste-code').value = '';
  });

  $('airgap-copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('airgap-text').value);
      appendLog('کد آفلاین کپی شد.');
    } catch (e) {
      $('airgap-text').select();
    }
  });

  $('airgap-done-btn').addEventListener('click', () => {
    $('airgap-stage').hidden = true;
  });
}

async function handleAirgapCode(code) {
  try {
    if (!code.startsWith('P2P:')) {
      // Regular invite fallback
      await addPeerFromInvite(code);
      return;
    }

    appendLog('در حال پردازش کد آفلاین P2P…');
    // Check if it's an offer or answer
    const clean = code.slice(4);
    const jsonStr = await (await import('./crypto.js')).decompressString(clean);
    const pkg = JSON.parse(jsonStr);

    if (pkg.t === 'OFFER') {
      appendLog('بسته Offer دریافت شد. در حال تولید پاسخ (Answer)…');
      const { answerCode, remotePeer } = await directConnect.processOfferAndCreateAnswer(code);
      $('airgap-stage-title').textContent = 'گام دوم: کد پاسخ مستقیم (Answer)';
      $('airgap-stage-desc').textContent = `پاسخ برای ${shorten(remotePeer.peerId)} آماده شد. گوشی اول باید این کد را اسکن کند تا اتصال نهایی شود.`;
      $('airgap-text').value = answerCode;
      renderQrToCanvas($('airgap-qr'), answerCode, { scale: 4 });
      $('airgap-stage').hidden = false;
    } else if (pkg.t === 'ANSWER') {
      appendLog('بسته Answer دریافت شد. در حال نهایی‌سازی اتصال مستقیم…');
      const peer = await directConnect.processAnswer(code);
      appendLog(`پاسخ اعمال شد برای ${shorten(peer.peerId)}. در انتظار باز شدن کانال داده…`);
    }
  } catch (err) {
    appendLog(`خطا در کد آفلاین: ${err.message}`);
  }
}

/* ==========================================================================
   PEERS & INVITES
   ========================================================================== */
function renderInvite() {
  const invite = node.buildInvite();
  $('invite-text').value = invite;
  try {
    renderQrToCanvas($('invite-qr'), invite, { scale: 5 });
  } catch (error) {
    appendLog(`خطای تولید QR دعوت: ${error.message}`);
  }
}

async function renderPeers() {
  const peers = (await peerStore.all()).sort((left, right) => (right.lastSeen || 0) - (left.lastSeen || 0));
  const list = $('peer-list');
  if (!list) return;
  list.innerHTML = '';
  $('peers-total-count').textContent = peers.length;

  for (const peer of peers) {
    const item = document.createElement('li');
    const isConnected = peer.status === 'CONNECTED';
    const sourceText = peer.source === 'AIR_GAP'
      ? '⚡ مستقیم بدون سرور'
      : (peer.source === 'MANUAL_QR' ? 'اسکن بارکد' : 'کشف خودکار مش');

    const relaysText = (peer.relayUrls && peer.relayUrls.length > 0)
      ? peer.relayUrls.join(', ')
      : 'رله پیش‌فرض';

    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="mono" style="font-weight: 600;">${peer.alias ? `${peer.alias} (${shorten(peer.peerId)})` : shorten(peer.peerId)}</span>
        <span class="status-${peer.status}">${peer.status === 'CONNECTED' ? 'متصل ✓' : 'قطع'}</span>
      </div>
      <div class="meta" style="font-size: 0.75rem;">
        منبع: ${sourceText} · نسخه: v${peer.sequence || 1} · رله‌های سینک‌شده: <span style="color: #60a5fa;">${relaysText}</span>
      </div>
      <div class="row" style="margin-top: 0.4rem;">
        <button class="secondary btn-sm" onclick="window.startChatWith('${peer.peerId}')">ارسال پیام در چت 💬</button>
      </div>
    `;
    list.appendChild(item);
  }

  const connected = peers.filter((p) => p.status === 'CONNECTED').length;
  $('connection-summary').textContent = `${connected} متصل از ${peers.length} همتا`;
}

async function renderServices() {
  const list = $('services-list');
  if (!list || !node) return;
  list.innerHTML = '';

  const relays = node.signaling.baseUrls;
  $('service-count-pill').textContent = `${relays.length} رله فعال`;

  for (const url of relays) {
    const item = document.createElement('li');
    item.style.padding = '0.4rem 0';
    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="mono" style="color: #93c5fd; font-size: 0.8rem;">${url}</span>
        <span class="badge" style="font-size: 0.7rem;">فعال در استخر</span>
      </div>
    `;
    list.appendChild(item);
  }
}


window.startChatWith = (peerId) => {
  const chatTab = document.querySelector('.tab[data-tab="chat"]');
  if (chatTab) chatTab.click();
  selectConversation(peerId);
};

async function addPeerFromInvite(raw) {
  try {
    const peer = await node.acceptInvite(raw.trim());
    appendLog(`همتا افزوده شد: ${shorten(peer.peerId)}`);
    $('paste-invite').value = '';
    await refreshAll();
  } catch (error) {
    appendLog(`دعوت نامعتبر: ${error.message}`);
  }
}

function bindPeerControls() {
  $('add-peer').addEventListener('click', () => addPeerFromInvite($('paste-invite').value));

  if (!isScannerSupported()) {
    $('start-scan').disabled = true;
    $('scanner-note').textContent = 'مرورگر شما از اسکنر دوربین پشتیبانی نمی‌کند؛ کد دعوت را دستی بچسبانید.';
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

/* ==========================================================================
   SETTINGS & IDENTITY
   ========================================================================== */
function bindIdentityControls() {
  $('relay-url').value = relayUrls();
  $('user-alias').value = userAlias();
  if ($('descriptor-version-pill') && node) {
    $('descriptor-version-pill').textContent = `نسخه شناسنامه: v${node.sequence}`;
  }

  // Broadcast and sync updated connection details
  const broadcastBtn = $('broadcast-descriptor');
  if (broadcastBtn) {
    broadcastBtn.addEventListener('click', async () => {
      const relays = $('relay-url').value.trim();
      const alias = $('user-alias').value.trim();
      try {
        const desc = await node.updateConnectionDetails({ relayUrls: relays, alias });
        $('descriptor-version-pill').textContent = `نسخه شناسنامه: v${desc.sequence}`;
        appendLog(`مشخصات جدید (نسخه v${desc.sequence}) با موفقیت به تمام همتاهای مش سینک شد.`);
        await refreshAll();
      } catch (err) {
        appendLog(`خطای انتشار مشخصات: ${err.message}`);
      }
    });
  }

  $('save-relay').addEventListener('click', () => {
    const relays = $('relay-url').value.trim();
    const alias = $('user-alias').value.trim();
    if (relays) localStorage.setItem(RELAY_STORAGE_KEY, relays);
    localStorage.setItem(ALIAS_STORAGE_KEY, alias);
    window.location.reload();
  });

  $('regenerate-identity').addEventListener('click', async () => {
    if (!window.confirm('تمامی هویت، زنجیره بلاکچین و پیام‌ها پاک خواهند شد. آیا مطمئن هستید؟')) return;
    node.stop();
    await wipeEverything();
    window.location.reload();
  });

  $('copy-invite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('invite-text').value);
      appendLog('کد دعوت در حافظه کپی شد.');
    } catch (error) {
      $('invite-text').select();
    }
  });
}

/* ==========================================================================
   OFFLINE & NETWORK STATUS
   ========================================================================== */
function updateNetworkStatus() {
  const offlineBadge = $('offline-badge');
  if (navigator.onLine) {
    offlineBadge.hidden = true;
  } else {
    offlineBadge.hidden = false;
  }
}

async function refreshAll() {
  await Promise.all([renderConversations(), renderChatMessages(), renderPeers(), renderServices()]);
}

/* ==========================================================================
   MAIN INITIALIZATION
   ========================================================================== */
async function main() {
  bindTabs();
  const identity = await loadIdentity();
  $('self-peer-id').textContent = identity.peerId;

  node = new MeshNode(identity, relayUrls());
  node.addEventListener('log', (event) => appendLog(event.detail));
  node.addEventListener('change', () => refreshAll());

  bindChatControls();
  bindDirectConnectControls();
  bindPeerControls();
  bindIdentityControls();
  bindModalControls();
  renderInvite();

  await node.start();
  if ($('descriptor-version-pill')) {
    $('descriptor-version-pill').textContent = `نسخه شناسنامه: v${node.sequence}`;
  }
  await refreshAll();

  // Audit ledger status on startup
  const audit = await verifyLedgerIntegrity();
  $('ledger-audit-result').innerHTML = audit.valid
    ? `<span class="status-ok">✓ زنجیره بلاکچین معتبر است (${audit.count} بلاک).</span>`
    : `<span style="color: #ef4444;">نقص در زنجیره: ${audit.errors[0]}</span>`;


  appendLog(`آماده به کار. رله‌های فعال: ${relayUrls()}`);

  updateNetworkStatus();
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

main().catch((error) => appendLog(`خطای راه‌اندازی: ${error.message}`));
