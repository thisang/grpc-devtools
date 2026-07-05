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
  console.log('[gRPC DevTools] BG: connection, name:', port.name);

  if (port.name.startsWith('grpc-panel-')) {
    const tabId = parseInt(port.name.replace('grpc-panel-', ''), 10);
    console.log('[gRPC DevTools] BG: panel connected for tabId:', tabId);
    panelPorts.set(tabId, port);

    // Send full snapshot from storage.session (covers SW restart recovery)
    getRequests(tabId).then((existing) => {
      console.log('[gRPC DevTools] BG: sending init with', existing.length, 'requests to tab', tabId);
      try {
        port.postMessage({ type: 'init', requests: existing });
      } catch (e) {
        console.warn('[gRPC DevTools] BG: init postMessage failed:', e);
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('[gRPC DevTools] BG: panel disconnected for tabId:', tabId);
      panelPorts.delete(tabId);
    });
  }
});

// Receive captured requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[gRPC DevTools] BG: onMessage:', message.type, 'from tab:', sender.tab?.id);

  if (message.type === 'grpc-request') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      console.warn('[gRPC DevTools] BG: no tabId, dropping');
      sendResponse({ ok: false });
      return false; // sync response, don't keep channel open
    }

    // Store first, then push to panel, then respond — all async.
    // return true keeps the SW alive until sendResponse is called.
    storeRequest(tabId, message.request).then(() => {
      console.log('[gRPC DevTools] BG: stored request for tab', tabId, 'url:', message.request.url);

      // Push to panel via port (real-time, no polling)
      const port = panelPorts.get(tabId);
      if (port) {
        console.log('[gRPC DevTools] BG: pushing to panel for tab', tabId);
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
      sendResponse({ ok: false, error: err.message });
    });

    return true; // keep channel open for async sendResponse
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
    });
    return true;
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
  // Trim
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
