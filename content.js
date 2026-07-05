/**
 * Content script (ISOLATED world)
 *
 * Listens for window.postMessage from the MAIN world page-hook.js,
 * and forwards captured gRPC request data to the background service
 * worker via chrome.runtime.sendMessage.
 *
 * This file does NOT have access to page-level fetch()/XHR — that's
 * handled by page-hook.js in the MAIN world.
 */

(function () {
  'use strict';

  if (window.__GRPC_DEVTOOLS_ISOLATED__) return;
  window.__GRPC_DEVTOOLS_ISOLATED__ = true;

  console.log('[gRPC DevTools] Content script (isolated) loaded');

  window.addEventListener('message', function (event) {
    // Only accept messages from the same window
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'grpc-devtools') return;

    var payload = event.data.payload;
    if (!payload) return;

    if (payload.type === 'grpc-request') {
      try {
        chrome.runtime.sendMessage({
          type: 'grpc-request',
          request: payload.request
        }, function () {
          // Swallow lastError — panel might not be open
          void chrome.runtime.lastError;
        });
      } catch (e) {
        console.warn('[gRPC DevTools] Failed to forward capture:', e);
      }
    }
  });
})();
