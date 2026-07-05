/**
 * Content script (ISOLATED world)
 * Bridges between page-context hooks and background service worker.
 *
 * Architecture:
 *   1. Inject page-script.js into page MAIN world (has access to fetch/XHR)
 *   2. page-script hooks fetch()/XMLHttpRequest, detects gRPC traffic
 *   3. page-script sends captured data via window.postMessage
 *   4. This content script (ISOLATED) listens for postMessage events
 *   5. Forwards data to background via chrome.runtime.sendMessage
 */

(function () {
  'use strict';

  if (window.__GRPC_DEVTOOLS_ISOLATED__) return;
  window.__GRPC_DEVTOOLS_ISOLATED__ = true;

  console.log('[gRPC DevTools] Content script (isolated) loaded');

  // ─── Listen for messages from page-context hooks ──────────────

  window.addEventListener('message', (event) => {
    // Only accept messages from the same window, tagged by our extension
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'grpc-devtools') return;

    const payload = event.data.payload;
    if (!payload) return;

    if (payload.type === 'grpc-request') {
      try {
        chrome.runtime.sendMessage({
          type: 'grpc-request',
          request: payload.request,
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[gRPC DevTools] sendMessage error:', chrome.runtime.lastError.message);
          }
        });
      } catch (e) {
        console.warn('[gRPC DevTools] Failed to forward capture:', e);
      }
    }
  });

  // ─── Inject page-context hook script ──────────────────────────

  function injectScript() {
    const script = document.createElement('script');
    script.textContent = '(' + pageScript.toString() + ')()';
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // Inject as early as possible to hook fetch before page code runs
  if (document.head || document.documentElement) {
    injectScript();
  } else {
    document.addEventListener('DOMContentLoaded', injectScript);
  }

  // ─── Page-context script (runs in MAIN world) ─────────────────

  function pageScript() {
    'use strict';

    // Avoid double-injection
    if (window.__GRPC_DEVTOOLS_PAGE_HOOKED__) return;
    window.__GRPC_DEVTOOLS_PAGE_HOOKED__ = true;

    const CONTENT_TYPE_GRPC = 'application/grpc';
    const CONTENT_TYPE_GRPC_PROTO = 'application/grpc+proto';
    const CONTENT_TYPE_GRPC_JSON = 'application/grpc+json';
    const CONTENT_TYPE_GRPC_WEB = 'application/grpc-web';
    const CONTENT_TYPE_GRPC_WEB_PROTO = 'application/grpc-web+proto';
    const CONTENT_TYPE_GRPC_WEB_TEXT = 'application/grpc-web-text';
    const CONTENT_TYPE_CONNECT_PROTO = 'application/connect+proto';
    const CONTENT_TYPE_CONNECT_JSON = 'application/connect+json';
    const CONTENT_TYPE_PROTO = 'application/proto';
    const CONTENT_TYPE_PROTOBUF = 'application/x-protobuf';

    const GRPC_CONTENT_TYPES = new Set([
      CONTENT_TYPE_GRPC,
      CONTENT_TYPE_GRPC_PROTO,
      CONTENT_TYPE_GRPC_JSON,
      CONTENT_TYPE_GRPC_WEB,
      CONTENT_TYPE_GRPC_WEB_PROTO,
      CONTENT_TYPE_GRPC_WEB_TEXT,
      CONTENT_TYPE_CONNECT_PROTO,
      CONTENT_TYPE_CONNECT_JSON,
      CONTENT_TYPE_PROTO,
      CONTENT_TYPE_PROTOBUF,
    ]);

    const GRPC_WEB_TEXT_TYPES = new Set([
      CONTENT_TYPE_GRPC_WEB_TEXT,
    ]);

    // ─── Utilities ───────────────────────────────────────────────

    function isGrpcContentType(contentType) {
      if (!contentType) return false;
      const ct = contentType.toLowerCase().split(';')[0].trim();
      return GRPC_CONTENT_TYPES.has(ct);
    }

    function isGrpcWebText(contentType) {
      if (!contentType) return false;
      const ct = contentType.toLowerCase().split(';')[0].trim();
      return GRPC_WEB_TEXT_TYPES.has(ct);
    }

    function looksLikeGrpcPath(url) {
      try {
        const u = new URL(url, location.origin);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) {
          const servicePart = parts[parts.length - 2];
          const methodPart = parts[parts.length - 1];
          if (servicePart.includes('.')) return true;
          if (/^[A-Z]/.test(methodPart) && /^[A-Za-z]/.test(servicePart)) return true;
        }
        return false;
      } catch {
        return false;
      }
    }

    function hasBinaryHeaders(headers) {
      if (!headers) return false;
      var ct = (headers['content-type'] || '').toLowerCase();
      var accept = (headers['accept'] || '').toLowerCase();
      return (
        ct.indexOf('proto') !== -1 ||
        ct.indexOf('grpc') !== -1 ||
        ct.indexOf('octet-stream') !== -1 ||
        accept.indexOf('grpc') !== -1 ||
        accept.indexOf('proto') !== -1
      );
    }

    function isGrpcRequest(url, requestHeaders, responseHeaders) {
      var resCt = responseHeaders ? responseHeaders['content-type'] : null;
      var reqCt = requestHeaders ? requestHeaders['content-type'] : null;
      if (isGrpcContentType(resCt) || isGrpcContentType(reqCt)) return true;
      if (looksLikeGrpcPath(url)) return true;
      if (hasBinaryHeaders(requestHeaders) && looksLikeGrpcPath(url)) return true;
      return false;
    }

    function extractGrpcStatus(headers) {
      var status = headers['grpc-status'];
      var message = headers['grpc-message'];
      if (status != null) {
        return {
          code: parseInt(status, 10),
          message: message ? decodeURIComponent(message) : undefined,
        };
      }
      return undefined;
    }

    function arrayBufferToBase64(buffer) {
      var bytes = new Uint8Array(buffer);
      var binary = '';
      var chunkSize = 0x8000;
      for (var i = 0; i < bytes.length; i += chunkSize) {
        var chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    }

    function decodeGrpcWebText(buffer) {
      try {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        var decoded = atob(binary);
        var result = new Uint8Array(decoded.length);
        for (var i = 0; i < decoded.length; i++) {
          result[i] = decoded.charCodeAt(i);
        }
        return result.buffer;
      } catch {
        return buffer;
      }
    }

    function parseGrpcFrames(buffer) {
      var frames = [];
      var view = new DataView(buffer);
      var offset = 0;

      while (offset + 5 <= buffer.byteLength) {
        var compressed = view.getUint8(offset);
        var length = view.getUint32(offset + 1, false);
        offset += 5;

        if (offset + length > buffer.byteLength) {
          var remaining = buffer.byteLength - offset;
          if (remaining > 0) {
            frames.push({
              compressed: compressed === 1,
              data: arrayBufferToBase64(buffer.slice(offset, offset + remaining)),
              truncated: true,
            });
          }
          break;
        }

        frames.push({
          compressed: compressed === 1,
          data: arrayBufferToBase64(buffer.slice(offset, offset + length)),
          truncated: false,
        });
        offset += length;
      }

      return frames;
    }

    function headerToLower(obj) {
      if (!obj) return {};
      var result = {};
      for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          result[k.toLowerCase ? k.toLowerCase() : String(k).toLowerCase()] = obj[k];
        }
      }
      return result;
    }

    // ─── Send to ISOLATED world via postMessage ──────────────────

    function sendToExtension(data) {
      try {
        window.postMessage({
          source: 'grpc-devtools',
          payload: data,
        }, '*');
      } catch (e) {
        // silently fail
      }
    }

    function processResponse(url, method, requestHeaders, requestBody, response) {
      var isGrpc = isGrpcRequest(url, requestHeaders, response.headers);
      if (!isGrpc) return;

      var rawBody = response.body;
      if (isGrpcWebText(response.headers['content-type'])) {
        rawBody = decodeGrpcWebText(rawBody);
      }

      var responseFrames = parseGrpcFrames(rawBody);
      var grpcStatus = extractGrpcStatus(response.headers);

      var requestFrames = [];
      if (requestBody) {
        var reqRaw = requestBody;
        if (isGrpcWebText(requestHeaders['content-type'])) {
          reqRaw = decodeGrpcWebText(requestBody);
        }
        requestFrames = parseGrpcFrames(reqRaw);
      }

      var serviceName = '';
      var methodName = '';
      try {
        var u = new URL(url, location.origin);
        var parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) {
          serviceName = parts[parts.length - 2];
          methodName = parts[parts.length - 1];
        }
      } catch {
        // ignore
      }

      // Normalize header keys to lowercase
      var normReqHeaders = {};
      if (requestHeaders) {
        Object.keys(requestHeaders).forEach(function (k) {
          normReqHeaders[k.toLowerCase()] = requestHeaders[k];
        });
      }
      var normResHeaders = {};
      if (response.headers) {
        Object.keys(response.headers).forEach(function (k) {
          normResHeaders[k.toLowerCase()] = response.headers[k];
        });
      }

      sendToExtension({
        type: 'grpc-request',
        request: {
          id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          timestamp: Date.now(),
          url: url,
          method: method,
          serviceName: serviceName,
          methodName: methodName,
          requestHeaders: normReqHeaders,
          requestFrames: requestFrames,
          responseStatus: response.status,
          responseStatusText: response.statusText,
          responseHeaders: normResHeaders,
          responseFrames: responseFrames,
          grpcStatus: grpcStatus,
          duration: response.duration,
        },
      });
    }

    // ─── Hook fetch() ────────────────────────────────────────────

    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (!url) return originalFetch.apply(this, arguments);
      var method = (init && init.method) || (typeof input !== 'string' && input ? input.method : 'GET') || 'GET';

      // Capture request headers
      var requestHeaders = {};
      if (init && init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach(function (v, k) { requestHeaders[k] = v; });
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(function (pair) { requestHeaders[pair[0]] = pair[1]; });
        } else if (typeof init.headers === 'object') {
          Object.keys(init.headers).forEach(function (k) { requestHeaders[k] = init.headers[k]; });
        }
      }

      // Capture request body
      var requestBodyBuffer = null;
      var bodyPromise = Promise.resolve(null);
      if (init && init.body) {
        if (init.body instanceof ArrayBuffer) {
          requestBodyBuffer = init.body;
        } else if (init.body instanceof Uint8Array) {
          requestBodyBuffer = init.body.buffer;
        } else if (init.body instanceof Blob) {
          bodyPromise = init.body.arrayBuffer().then(function (buf) { requestBodyBuffer = buf; });
        } else if (typeof init.body === 'string') {
          requestBodyBuffer = new TextEncoder().encode(init.body).buffer;
        }
      }

      var startTime = performance.now();

      return bodyPromise.then(function () {
        return originalFetch.apply(this, arguments);
      }.bind(this)).then(function (response) {
        // Only process gRPC requests (check before consuming body)
        if (!isGrpcRequest(url, requestHeaders, null)) return response;

        var cloned = response.clone();
        return cloned.arrayBuffer().then(function (bodyBuffer) {
          var responseHeaders = {};
          cloned.headers.forEach(function (v, k) { responseHeaders[k] = v; });

          processResponse(url, method, requestHeaders, requestBodyBuffer, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: bodyBuffer,
            duration: performance.now() - startTime,
          });
        }).catch(function (err) {
          console.warn('[gRPC DevTools] Failed to process fetch response:', err);
        }).then(function () {
          return response;
        });
      }).catch(function (err) {
        // Capture network errors for gRPC requests
        if (isGrpcRequest(url, requestHeaders, null)) {
          sendToExtension({
            type: 'grpc-request',
            request: {
              id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
              timestamp: Date.now(),
              url: url,
              method: method,
              serviceName: '',
              methodName: '',
              requestHeaders: requestHeaders,
              requestFrames: [],
              responseStatus: 0,
              responseStatusText: 'Network Error',
              responseHeaders: {},
              responseFrames: [],
              grpcStatus: { code: 14, message: (err && err.message) || 'Network error' },
              duration: performance.now() - startTime,
              error: true,
            },
          });
        }
        throw err;
      });
    };

    // ─── Hook XMLHttpRequest ─────────────────────────────────────

    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    var originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__grpc_url = url;
      this.__grpc_method = method;
      this.__grpc_requestHeaders = {};
      this.__grpc_startTime = 0;
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this.__grpc_requestHeaders) {
        this.__grpc_requestHeaders[name] = value;
      }
      return originalSetRequestHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (body) {
      this.__grpc_startTime = performance.now();

      var requestBodyBuffer = null;
      if (body) {
        if (body instanceof ArrayBuffer) {
          requestBodyBuffer = body;
        } else if (body instanceof Uint8Array) {
          requestBodyBuffer = body.buffer;
        } else if (body instanceof Blob) {
          body.arrayBuffer().then(function (buf) { this.__grpc_requestBody = buf; }.bind(this));
        } else if (typeof body === 'string') {
          requestBodyBuffer = new TextEncoder().encode(body).buffer;
        }
      }
      this.__grpc_requestBody = requestBodyBuffer;

      var self = this;

      this.addEventListener('loadend', function () {
        var url = self.__grpc_url;
        var method = self.__grpc_method;
        var requestHeaders = self.__grpc_requestHeaders || {};

        var responseHeaders = {};
        try {
          var rawHeaders = self.getAllResponseHeaders();
          if (rawHeaders) {
            rawHeaders.split('\r\n').forEach(function (line) {
              var idx = line.indexOf(': ');
              if (idx > 0) {
                responseHeaders[line.substring(0, idx).toLowerCase()] = line.substring(idx + 2);
              }
            });
          }
        } catch {
          // ignore
        }

        if (!isGrpcRequest(url, requestHeaders, responseHeaders)) return;

        var bodyBuffer;
        try {
          if (self.responseType === 'arraybuffer' || self.responseType === '') {
            if (self.response instanceof ArrayBuffer) {
              bodyBuffer = self.response;
            } else if (self.responseType === '' && typeof self.response === 'string') {
              bodyBuffer = new TextEncoder().encode(self.response).buffer;
            }
          }
        } catch {
          // ignore
        }

        if (!bodyBuffer) return;

        processResponse(url, method, requestHeaders, self.__grpc_requestBody, {
          status: self.status,
          statusText: self.statusText,
          headers: responseHeaders,
          body: bodyBuffer,
          duration: performance.now() - self.__grpc_startTime,
        });
      });

      return originalSend.call(this, body);
    };

    console.log('[gRPC DevTools] Page hooks installed. Supported content-types: ' +
      Array.from(GRPC_CONTENT_TYPES).join(', '));
  }
})();
