/**
 * Background service worker
 *
 * Architecture:
 *   page-hook.js (MAIN world) → window.postMessage → content.js (ISOLATED)
 *   content.js → chrome.runtime.sendMessage → background (here)
 *   background → port.postMessage → panel.js (DevTools)
 *
 * Storage:
 *   chrome.storage.session — used ONLY to survive SW restarts.
 *   When a panel reconnects (after SW was killed), it gets a full
 *   snapshot from storage.session via the 'init' message.
 *
 * No polling. All updates are push-based via port.postMessage.
 */

const MAX_REQUESTS = 500;

// Connected DevTools panels: key = tabId, value = port
const panelPorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  try {
    console.log('[gRPC DevTools] BG: connection, name:', port.name);

    if (!port.name || !port.name.startsWith('grpc-panel-')) {
      console.log('[gRPC DevTools] BG: ignoring non-panel connection:', port.name);
      return;
    }

    const tabIdStr = port.name.replace('grpc-panel-', '');
    const tabId = parseInt(tabIdStr, 10);
    if (isNaN(tabId)) {
      console.warn('[gRPC DevTools] BG: invalid tabId in port name:', port.name);
      return;
    }

    console.log('[gRPC DevTools] BG: panel connected for tabId:', tabId);
    panelPorts.set(tabId, port);

    // Send full snapshot from storage.session.
    // Use sendResponse pattern: send init message, and also store the port.
    getRequests(tabId).then((existing) => {
      console.log('[gRPC DevTools] BG: sending init with', existing.length, 'requests to tab', tabId);
      try {
        port.postMessage({ type: 'init', requests: existing });
      } catch (e) {
        console.warn('[gRPC DevTools] BG: init postMessage failed:', e);
        panelPorts.delete(tabId);
      }
    }).catch((err) => {
      console.error('[gRPC DevTools] BG: getRequests failed:', err);
    });

    port.onDisconnect.addListener(() => {
      console.log('[gRPC DevTools] BG: panel disconnected for tabId:', tabId);
      panelPorts.delete(tabId);
    });
  } catch (e) {
    console.error('[gRPC DevTools] BG: error in onConnect handler:', e);
  }
});

// Receive captured requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    console.log('[gRPC DevTools] BG: onMessage:', message.type, 'from tab:', sender.tab?.id);

    if (message.type === 'grpc-request') {
      const tabId = sender.tab?.id;
      if (tabId == null) {
        console.warn('[gRPC DevTools] BG: no tabId, dropping');
        sendResponse({ ok: false, error: 'no tabId' });
        return false;
      }

      // Store + push + respond. return true to keep channel open.
      storeRequest(tabId, message.request).then(() => {
        console.log('[gRPC DevTools] BG: stored request for tab', tabId, 'url:', message.request.url);

        const port = panelPorts.get(tabId);
        if (port) {
          console.log('[gRPC DevTools] BG: pushing new-request to panel for tab', tabId);
          try {
            port.postMessage({ type: 'new-request', request: message.request });
          } catch (e) {
            console.warn('[gRPC DevTools] BG: port.postMessage failed:', e);
            panelPorts.delete(tabId);
          }
        } else {
          console.log('[gRPC DevTools] BG: no panel connected for tab', tabId, '(stored, will send on connect)');
        }

        sendResponse({ ok: true });
      }).catch((err) => {
        console.error('[gRPC DevTools] BG: storeRequest failed:', err);
        try { sendResponse({ ok: false, error: err.message }); } catch (e) { /* ignore */ }
      });

      return true; // keep channel open
    }

    if (message.type === 'clear-requests') {
      const tabId = message.tabId;
      chrome.storage.session.set({ ['tab-' + tabId]: [] }).then(() => {
        const port = panelPorts.get(tabId);
        if (port) {
          try {
            port.postMessage({ type: 'cleared' });
          } catch (e) {
            console.warn('[gRPC DevTools] BG: clear postMessage failed:', e);
          }
        }
        sendResponse({ ok: true });
      }).catch((err) => {
        console.error('[gRPC DevTools] BG: clear failed:', err);
        try { sendResponse({ ok: false, error: err.message }); } catch (e) { /* ignore */ }
      });
      return true;
    }
  } catch (e) {
    console.error('[gRPC DevTools] BG: error in onMessage handler:', e);
    try { sendResponse({ ok: false, error: e.message }); } catch (ignored) { /* ignore */ }
  }

  return false;
});

// ─── Storage helpers ──────────────────────────────────────────

async function getRequests(tabId) {
  const key = 'tab-' + tabId;
  const result = await chrome.storage.session.get(key);
  return result[key] || [];
}

async function storeRequest(tabId, request) {
  const key = 'tab-' + tabId;
  const requests = await getRequests(tabId);
  requests.push(request);
  if (requests.length > MAX_REQUESTS) {
    requests.splice(0, requests.length - MAX_REQUESTS);
  }
  await chrome.storage.session.set({ [key]: requests });
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('tab-' + tabId);
  panelPorts.delete(tabId);
});
