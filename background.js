/**
 * Background service worker
 * Coordinates between content scripts and DevTools panel
 * Stores captured gRPC requests in memory + chrome.storage
 */

// In-memory store for the current tab's gRPC requests
// Key: tabId, Value: array of GrpcRequest
const tabRequests = new Map();

// Connected DevTools panels: key = tabId, value = port
const panelPorts = new Map();

const MAX_REQUESTS = 500;

chrome.runtime.onConnect.addListener((port) => {
  console.log('[gRPC DevTools] BG: connection received, name:', port.name);

  // DevTools panel connection: name = "grpc-panel-<tabId>"
  if (port.name.startsWith('grpc-panel-')) {
    const tabId = parseInt(port.name.replace('grpc-panel-', ''), 10);
    console.log('[gRPC DevTools] BG: panel connected for tabId:', tabId);

    panelPorts.set(tabId, port);

    // Send existing requests for this tab
    const existing = tabRequests.get(tabId) || [];
    console.log('[gRPC DevTools] BG: sending init with', existing.length, 'requests to tab', tabId);
    port.postMessage({ type: 'init', requests: existing });

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
      console.warn('[gRPC DevTools] BG: no tabId in sender, dropping request');
      return;
    }

    const requests = tabRequests.get(tabId) || [];
    requests.push(message.request);
    console.log('[gRPC DevTools] BG: stored request for tab', tabId, 'total:', requests.length, 'url:', message.request.url);

    // Trim if too many
    if (requests.length > MAX_REQUESTS) {
      requests.splice(0, requests.length - MAX_REQUESTS);
    }
    tabRequests.set(tabId, requests);

    // Forward to connected panel
    const port = panelPorts.get(tabId);
    if (port) {
      console.log('[gRPC DevTools] BG: forwarding to panel for tab', tabId);
      port.postMessage({ type: 'new-request', request: message.request });
    } else {
      console.log('[gRPC DevTools] BG: no panel connected for tab', tabId, '(will show when panel opens)');
    }

    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'clear-requests') {
    const tabId = message.tabId;
    tabRequests.set(tabId, []);
    const port = panelPorts.get(tabId);
    if (port) {
      port.postMessage({ type: 'cleared' });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'get-requests') {
    const tabId = message.tabId;
    const requests = tabRequests.get(tabId) || [];
    sendResponse({ requests });
    return true;
  }
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabRequests.delete(tabId);
  panelPorts.delete(tabId);
});
