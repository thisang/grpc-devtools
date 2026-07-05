/**
 * Content script (runs in MAIN world)
 * Hooks fetch() and XMLHttpRequest to intercept gRPC / gRPC-Web traffic.
 * Sends captured binary payloads to the background service worker.
 */

(function () {
  'use strict';

  // Avoid double-injection
  if (window.__GRPC_DEVTOOLS_HOOKED__) return;
  window.__GRPC_DEVTOOLS_HOOKED__ = true;

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

  const DEBUG = false; // Set to true for verbose console logging

  /**
   * Check if a content-type header indicates gRPC traffic
   */
  function isGrpcContentType(contentType) {
    if (!contentType) return false;
    const ct = contentType.toLowerCase().split(';')[0].trim();
    return GRPC_CONTENT_TYPES.has(ct);
  }

  /**
   * Check if content-type indicates grpc-web-text (base64 encoded)
   */
  function isGrpcWebText(contentType) {
    if (!contentType) return false;
    const ct = contentType.toLowerCase().split(';')[0].trim();
    return GRPC_WEB_TEXT_TYPES.has(ct);
  }

  /**
   * Check if a URL looks like a gRPC endpoint (heuristic)
   */
  function looksLikeGrpcPath(url) {
    try {
      const u = new URL(url);
      // gRPC-Web typically uses paths like /package.Service/Method
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const servicePart = parts[parts.length - 2];
        const methodPart = parts[parts.length - 1];
        // Service names usually contain a dot: package.ServiceName
        if (servicePart.includes('.')) return true;
        // Method names often start with uppercase (gRPC convention)
        if (/^[A-Z]/.test(methodPart) && /^[A-Za-z]/.test(servicePart)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if the headers suggest binary/protobuf payload
   */
  function hasBinaryHeaders(headers) {
    if (!headers) return false;
    const ct = (headers['content-type'] || '').toLowerCase();
    // Also check for accept headers
    const accept = (headers['accept'] || '').toLowerCase();
    return (
      ct.includes('proto') ||
      ct.includes('grpc') ||
      ct.includes('octet-stream') ||
      accept.includes('grpc') ||
      accept.includes('proto')
    );
  }

  /**
   * Combined check: is this likely a gRPC call?
   */
  function isGrpcRequest(url, requestHeaders, responseHeaders) {
    const resCt = responseHeaders?.['content-type'];
    const reqCt = requestHeaders?.['content-type'];

    // Exact content-type match
    if (isGrpcContentType(resCt) || isGrpcContentType(reqCt)) return true;

    // Path-based heuristic
    if (looksLikeGrpcPath(url)) return true;

    // Binary headers + method=POST on a non-RESTful path
    if (hasBinaryHeaders(requestHeaders) && looksLikeGrpcPath(url)) return true;

    return false;
  }

  /**
   * Extract gRPC status and message from trailers/response headers
   */
  function extractGrpcStatus(headers) {
    const status = headers['grpc-status'];
    const message = headers['grpc-message'];
    if (status != null) {
      return {
        code: parseInt(status, 10),
        message: message ? decodeURIComponent(message) : undefined,
      };
    }
    return undefined;
  }

  /**
   * Convert ArrayBuffer / Uint8Array to base64 string
   */
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  /**
   * Decode grpc-web-text (base64 encoded) to raw bytes
   */
  function decodeGrpcWebText(buffer) {
    try {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const decoded = atob(binary);
      const result = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        result[i] = decoded.charCodeAt(i);
      }
      return result.buffer;
    } catch {
      return buffer;
    }
  }

  /**
   * Parse gRPC frame: [compressed flag (1 byte)] [length (4 bytes BE)] [payload]
   * Returns array of raw protobuf payloads
   */
  function parseGrpcFrames(buffer) {
    const frames = [];
    const view = new DataView(buffer);
    let offset = 0;

    while (offset + 5 <= buffer.byteLength) {
      const compressed = view.getUint8(offset);
      const length = view.getUint32(offset + 1, false); // big-endian
      offset += 5;

      if (offset + length > buffer.byteLength) {
        // Incomplete frame, grab what's available
        const remaining = buffer.byteLength - offset;
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

  /**
   * Build and send a capture record to background
   */
  function captureRequest(record) {
    try {
      chrome.runtime.sendMessage({
        type: 'grpc-request',
        request: record,
      });
      if (DEBUG) console.debug('[gRPC DevTools] Captured request:', record.serviceName + '/' + record.methodName, record.url);
    } catch (e) {
      console.warn('[gRPC DevTools] Failed to send capture:', e);
    }
  }

  /**
   * Process a fetch response or XHR response
   */
  function processResponse(url, method, requestHeaders, requestBody, response) {
    // response: { status, statusText, headers, body (ArrayBuffer) }
    const isGrpc = isGrpcRequest(url, requestHeaders, response.headers);

    if (!isGrpc) {
      if (DEBUG) console.debug('[gRPC DevTools] Skipped non-gRPC request:', url);
      return;
    }

    let rawBody = response.body;
    if (isGrpcWebText(response.headers['content-type'])) {
      rawBody = decodeGrpcWebText(rawBody);
    }

    const responseFrames = parseGrpcFrames(rawBody);
    const grpcStatus = extractGrpcStatus(response.headers);

    // Parse request body frames too
    let requestFrames = [];
    if (requestBody) {
      let reqRaw = requestBody;
      if (isGrpcWebText(requestHeaders['content-type'])) {
        reqRaw = decodeGrpcWebText(requestBody);
      }
      requestFrames = parseGrpcFrames(reqRaw);
    }

    // Extract service and method from URL path
    let serviceName = '';
    let methodName = '';
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        serviceName = parts[parts.length - 2];
        methodName = parts[parts.length - 1];
      }
    } catch {
      // ignore
    }

    captureRequest({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      url: url,
      method: method,
      serviceName: serviceName,
      methodName: methodName,
      requestHeaders: requestHeaders,
      requestFrames: requestFrames,
      responseStatus: response.status,
      responseStatusText: response.statusText,
      responseHeaders: response.headers,
      responseFrames: responseFrames,
      grpcStatus: grpcStatus,
      duration: response.duration,
    });
  }

  // ─── Hook fetch() ──────────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = init?.method || (typeof input !== 'string' ? input?.method : 'GET') || 'GET';

    // Capture request headers
    const requestHeaders = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { requestHeaders[k] = v; });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([k, v]) => { requestHeaders[k] = v; });
      } else if (typeof init.headers === 'object') {
        Object.assign(requestHeaders, init.headers);
      }
    }

    // Capture request body
    let requestBodyBuffer = null;
    if (init?.body) {
      if (init.body instanceof ArrayBuffer) {
        requestBodyBuffer = init.body;
      } else if (init.body instanceof Uint8Array) {
        requestBodyBuffer = init.body.buffer;
      } else if (init.body instanceof Blob) {
        requestBodyBuffer = await init.body.arrayBuffer();
      } else if (typeof init.body === 'string') {
        requestBodyBuffer = new TextEncoder().encode(init.body).buffer;
      }
    }

    const startTime = performance.now();

    try {
      const response = await originalFetch.apply(this, arguments);

      // Clone the response to read its body without consuming it
      const cloned = response.clone();
      const contentType = response.headers.get('content-type') || '';

      const isGrpc = isGrpcRequest(url, requestHeaders, null);

      if (isGrpc) {
        try {
          const bodyBuffer = await cloned.arrayBuffer();
          const responseHeaders = {};
          cloned.headers.forEach((v, k) => { responseHeaders[k] = v; });

          processResponse(url, method, requestHeaders, requestBodyBuffer, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: bodyBuffer,
            duration: performance.now() - startTime,
          });
        } catch (err) {
          console.warn('[gRPC DevTools] Failed to process gRPC response:', err);
        }
      }

      return response;
    } catch (err) {
      // If it's a gRPC request that errored, capture the error
      if (isGrpcRequest(url, requestHeaders, null)) {
        captureRequest({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: Date.now(),
          url: url,
          method: method,
          serviceName: '',
          methodName: '',
          requestHeaders: requestHeaders,
          requestFrames: requestBodyBuffer ? parseGrpcFrames(
            requestHeaders['content-type']?.includes('grpc-web-text')
              ? decodeGrpcWebText(requestBodyBuffer)
              : requestBodyBuffer
          ) : [],
          responseStatus: 0,
          responseStatusText: 'Network Error',
          responseHeaders: {},
          responseFrames: [],
          grpcStatus: { code: 14, message: err?.message || 'Network error' },
          duration: performance.now() - startTime,
          error: true,
        });
      }
      throw err;
    }
  };

  // ─── Hook XMLHttpRequest ───────────────────────────────────────

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__grpc_url = url;
    this.__grpc_method = method;
    this.__grpc_requestHeaders = {};
    this.__grpc_startTime = 0;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__grpc_requestHeaders) {
      this.__grpc_requestHeaders[name] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.__grpc_startTime = performance.now();

    // Capture request body
    let requestBodyBuffer = null;
    if (body) {
      if (body instanceof ArrayBuffer) {
        requestBodyBuffer = body;
      } else if (body instanceof Uint8Array) {
        requestBodyBuffer = body.buffer;
      } else if (body instanceof Blob) {
        // Blob needs async; capture URL for now
        body.arrayBuffer().then(buf => { this.__grpc_requestBody = buf; });
      } else if (typeof body === 'string') {
        requestBodyBuffer = new TextEncoder().encode(body).buffer;
      }
    }
    this.__grpc_requestBody = requestBodyBuffer;

    const self = this;

    this.addEventListener('loadend', function () {
      const url = self.__grpc_url;
      const method = self.__grpc_method;
      const requestHeaders = self.__grpc_requestHeaders || {};

      // Get response headers first
      const responseHeaders = {};
      const rawHeaders = self.getAllResponseHeaders();
      if (rawHeaders) {
        rawHeaders.split('\r\n').forEach(line => {
          const idx = line.indexOf(': ');
          if (idx > 0) {
            responseHeaders[line.substring(0, idx).toLowerCase()] = line.substring(idx + 2);
          }
        });
      }

      const isGrpc = isGrpcRequest(url, requestHeaders, responseHeaders);

      if (!isGrpc) return;

      // Get response body as ArrayBuffer
      let bodyBuffer;
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

  console.log('[gRPC DevTools] Content script hooks installed. Supported content-types:', [...GRPC_CONTENT_TYPES].join(', '));
})();
