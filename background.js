/**
 * Background service worker
 * Stores captured gRPC requests in chrome.storage.session (survives SW restarts)
 * Forwards to DevTools panel via port if connected
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

    // Send existing requests for this tab
    getRequests(tabId).then((existing) => {
      console.log('[gRPC DevTools] BG: sending init with', existing.length, 'requests to tab', tabId);
      port.postMessage({ type: 'init', requests: existing });
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
      return true;
    }

    // Store in chrome.storage.session (survives SW restart)
    storeRequest(tabId, message.request).then(() => {
      console.log('[gRPC DevTools] BG: stored request for tab', tabId, 'url:', message.request.url);

      // Try to forward via port (instant update)
      const port = panelPorts.get(tabId);
      if (port) {
        console.log('[gRPC DevTools] BG: forwarding to panel for tab', tabId);
        try {
          port.postMessage({ type: 'new-request', request: message.request });
        } catch (e) {
          console.warn('[gRPC DevTools] BG: port.postMessage failed:', e);
          panelPorts.delete(tabId);
        }
      } else {
        console.log('[gRPC DevTools] BG: no panel for tab', tabId, '(panel will pick it up via polling)');
      }
    });

    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'get-requests') {
    const tabId = message.tabId;
    getRequests(tabId).then((requests) => {
      console.log('[gRPC DevTools] BG: get-requests for tab', tabId, '→', requests.length, 'requests');
      sendResponse({ requests });
    });
    return true; // async
  }

  if (message.type === 'clear-requests') {
    const tabId = message.tabId;
    chrome.storage.session.set({ ['tab-' + tabId]: [] }).then(() => {
      const port = panelPorts.get(tabId);
      if (port) port.postMessage({ type: 'cleared' });
      sendResponse({ ok: true });
    });
    return true;
  }
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
