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
  if (port.name === 'grpc-devtools-panel') {
    const tabId = port.sender?.tab?.id;
    if (tabId == null) return;

    panelPorts.set(tabId, port);

    // Send existing requests for this tab
    const existing = tabRequests.get(tabId) || [];
    port.postMessage({ type: 'init', requests: existing });

    port.onDisconnect.addListener(() => {
      panelPorts.delete(tabId);
    });
  }
});

// Receive captured requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'grpc-request') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;

    const requests = tabRequests.get(tabId) || [];
    requests.push(message.request);

    // Trim if too many
    if (requests.length > MAX_REQUESTS) {
      requests.splice(0, requests.length - MAX_REQUESTS);
    }
    tabRequests.set(tabId, requests);

    // Forward to connected panel
    const port = panelPorts.get(tabId);
    if (port) {
      port.postMessage({ type: 'new-request', request: message.request });
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
