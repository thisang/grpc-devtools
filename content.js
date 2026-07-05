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

    console.log('[gRPC DevTools] Isolated: received postMessage, type:', payload.type);

    if (payload.type === 'grpc-request') {
      console.log('[gRPC DevTools] Isolated: forwarding request to background:', payload.request.url);
      try {
        chrome.runtime.sendMessage({
          type: 'grpc-request',
          request: payload.request
        }, function () {
          if (chrome.runtime.lastError) {
            console.warn('[gRPC DevTools] Isolated: sendMessage error:', chrome.runtime.lastError.message);
          } else {
            console.log('[gRPC DevTools] Isolated: sendMessage success');
          }
        });
      } catch (e) {
        console.warn('[gRPC DevTools] Isolated: failed to forward capture:', e);
      }
    }
  });
})();
