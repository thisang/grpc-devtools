/**
 * Page hook script (runs in MAIN world via manifest content_scripts)
 *
 * This file is injected by Chrome directly into the page's JavaScript context
 * at document_start. It does NOT have access to chrome.runtime.* APIs.
 *
 * Communication: uses window.postMessage to send captured data to the
 * ISOLATED world content script (content.js), which forwards it to
 * the background service worker via chrome.runtime.sendMessage.
 */

(function () {
  'use strict';

  // Avoid double-injection
  if (window.__GRPC_DEVTOOLS_PAGE_HOOKED__) return;
  window.__GRPC_DEVTOOLS_PAGE_HOOKED__ = true;

  var GRPC_CONTENT_TYPES = {
    'application/grpc': true,
    'application/grpc+proto': true,
    'application/grpc+json': true,
    'application/grpc-web': true,
    'application/grpc-web+proto': true,
    'application/grpc-web-text': true,
    'application/connect+proto': true,
    'application/connect+json': true,
    'application/proto': true,
    'application/x-protobuf': true
  };

  function isGrpcContentType(ct) {
    if (!ct) return false;
    var key = ct.toLowerCase().split(';')[0].trim();
    return GRPC_CONTENT_TYPES[key] === true;
  }

  function isGrpcWebText(ct) {
    if (!ct) return false;
    return ct.toLowerCase().split(';')[0].trim() === 'application/grpc-web-text';
  }

  function looksLikeGrpcPath(url) {
    try {
      var u = new URL(url, location.origin);
      var parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        var servicePart = parts[parts.length - 2];
        var methodPart = parts[parts.length - 1];
        if (servicePart.indexOf('.') !== -1) return true;
        if (/^[A-Z]/.test(methodPart) && /^[A-Za-z]/.test(servicePart)) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function isGrpcRequest(url, requestHeaders, responseHeaders) {
    var resCt = responseHeaders ? responseHeaders['content-type'] : null;
    var reqCt = requestHeaders ? requestHeaders['content-type'] : null;
    if (isGrpcContentType(resCt) || isGrpcContentType(reqCt)) return true;
    if (looksLikeGrpcPath(url)) return true;
    return false;
  }

  function extractGrpcStatus(headers) {
    var status = headers['grpc-status'];
    var message = headers['grpc-message'];
    if (status != null) {
      return {
        code: parseInt(status, 10),
        message: message ? decodeURIComponent(message) : undefined
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
    } catch (e) {
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
            truncated: true
          });
        }
        break;
      }
      frames.push({
        compressed: compressed === 1,
        data: arrayBufferToBase64(buffer.slice(offset, offset + length)),
        truncated: false
      });
      offset += length;
    }
    return frames;
  }

  function sendToExtension(data) {
    try {
      window.postMessage({ source: 'grpc-devtools', payload: data }, '*');
    } catch (e) {
      // silently fail
    }
  }

  function normalizeHeaders(headers) {
    var result = {};
    if (!headers) return result;
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      result[keys[i].toLowerCase()] = headers[keys[i]];
    }
    return result;
  }

  function processResponse(url, method, requestHeaders, requestBody, response) {
    if (!isGrpcRequest(url, requestHeaders, response.headers)) return;

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
    } catch (e) {
      // ignore
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
        requestHeaders: normalizeHeaders(requestHeaders),
        requestFrames: requestFrames,
        responseStatus: response.status,
        responseStatusText: response.statusText,
        responseHeaders: normalizeHeaders(response.headers),
        responseFrames: responseFrames,
        grpcStatus: grpcStatus,
        duration: response.duration
      }
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
        var hkeys = Object.keys(init.headers);
        for (var hi = 0; hi < hkeys.length; hi++) {
          requestHeaders[hkeys[hi]] = init.headers[hkeys[hi]];
        }
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
          duration: performance.now() - startTime
        });
      }).catch(function (err) {
        console.warn('[gRPC DevTools] Failed to process fetch response:', err);
      }).then(function () {
        return response;
      });
    }).catch(function (err) {
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
            requestHeaders: normalizeHeaders(requestHeaders),
            requestFrames: [],
            responseStatus: 0,
            responseStatusText: 'Network Error',
            responseHeaders: {},
            responseFrames: [],
            grpcStatus: { code: 14, message: (err && err.message) || 'Network error' },
            duration: performance.now() - startTime,
            error: true
          }
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
        var self = this;
        body.arrayBuffer().then(function (buf) { self.__grpc_requestBody = buf; });
      } else if (typeof body === 'string') {
        requestBodyBuffer = new TextEncoder().encode(body).buffer;
      }
    }
    this.__grpc_requestBody = requestBodyBuffer;

    var xhrSelf = this;

    this.addEventListener('loadend', function () {
      var url = xhrSelf.__grpc_url;
      var method = xhrSelf.__grpc_method;
      var requestHeaders = xhrSelf.__grpc_requestHeaders || {};

      var responseHeaders = {};
      try {
        var rawHeaders = xhrSelf.getAllResponseHeaders();
        if (rawHeaders) {
          rawHeaders.split('\r\n').forEach(function (line) {
            var idx = line.indexOf(': ');
            if (idx > 0) {
              responseHeaders[line.substring(0, idx).toLowerCase()] = line.substring(idx + 2);
            }
          });
        }
      } catch (e) {
        // ignore
      }

      if (!isGrpcRequest(url, requestHeaders, responseHeaders)) return;

      var bodyBuffer;
      try {
        if (xhrSelf.responseType === 'arraybuffer' || xhrSelf.responseType === '') {
          if (xhrSelf.response instanceof ArrayBuffer) {
            bodyBuffer = xhrSelf.response;
          } else if (xhrSelf.responseType === '' && typeof xhrSelf.response === 'string') {
            bodyBuffer = new TextEncoder().encode(xhrSelf.response).buffer;
          }
        }
      } catch (e) {
        // ignore
      }

      if (!bodyBuffer) return;

      processResponse(url, method, requestHeaders, xhrSelf.__grpc_requestBody, {
        status: xhrSelf.status,
        statusText: xhrSelf.statusText,
        headers: responseHeaders,
        body: bodyBuffer,
        duration: performance.now() - xhrSelf.__grpc_startTime
      });
    });

    return originalSend.call(this, body);
  };

  console.log('[gRPC DevTools] Page hooks installed. Supported content-types: ' +
    Object.keys(GRPC_CONTENT_TYPES).join(', '));
})();
