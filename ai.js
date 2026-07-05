/**
 * AI Assistant module
 * Provides intelligent debugging capabilities:
 * - Error code diagnosis
 * - Request/response summarization
 * - Natural language search
 * - Replay code generation
 * - Schema inference
 */

const GrpcAI = (function () {
  'use strict';

  // gRPC status code reference
  const GRPC_STATUS_CODES = {
    0: { name: 'OK', description: 'Success' },
    1: { name: 'CANCELLED', description: 'The operation was cancelled, typically by the caller.' },
    2: { name: 'UNKNOWN', description: 'An unknown error. Could be a server-side crash or protocol mismatch.' },
    3: { name: 'INVALID_ARGUMENT', description: 'The client specified an invalid argument.' },
    4: { name: 'DEADLINE_EXCEEDED', description: 'The deadline expired before the operation could complete.' },
    5: { name: 'NOT_FOUND', description: 'Some requested entity was not found.' },
    6: { name: 'ALREADY_EXISTS', description: 'Some entity already exists.' },
    7: { name: 'PERMISSION_DENIED', description: 'The caller does not have permission to execute the specified operation.' },
    8: { name: 'RESOURCE_EXHAUSTED', description: 'Some resource has been exhausted, e.g. quota or rate limit.' },
    9: { name: 'FAILED_PRECONDITION', description: 'The system is not in a state required for the operation.' },
    10: { name: 'ABORTED', description: 'The operation was aborted, e.g. due to concurrency issue.' },
    11: { name: 'OUT_OF_RANGE', description: 'The operation was attempted past the valid range.' },
    12: { name: 'UNIMPLEMENTED', description: 'The operation is not implemented or not supported.' },
    13: { name: 'INTERNAL', description: 'Internal errors. Server-side bug.' },
    14: { name: 'UNAVAILABLE', description: 'The service is currently unavailable. Most often a transient condition.' },
    15: { name: 'DATA_LOSS', description: 'Unrecoverable data loss or corruption.' },
    16: { name: 'UNAUTHENTICATED', description: 'The request does not have valid authentication credentials.' },
  };

  let config = {
    provider: 'openai',
    apiKey: '',
    model: 'gpt-4o-mini',
    baseUrl: '',
  };

  // Load config from chrome.storage
  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get('grpc_ai_config', (result) => {
        if (result.grpc_ai_config) {
          config = { ...config, ...result.grpc_ai_config };
        }
        resolve(config);
      });
    });
  }

  function saveConfig(newConfig) {
    config = { ...config, ...newConfig };
    return new Promise((resolve) => {
      chrome.storage.local.set({ grpc_ai_config: config }, resolve);
    });
  }

  function getConfig() {
    return config;
  }

  function isConfigured() {
    return !!config.apiKey;
  }

  /**
   * Get the API endpoint for chat completions
   */
  function getApiEndpoint() {
    if (config.baseUrl) {
      return config.baseUrl.replace(/\/$/, '') + '/chat/completions';
    }
    switch (config.provider) {
      case 'anthropic':
        return 'https://api.anthropic.com/v1/messages';
      case 'custom':
        return 'http://localhost:8080/v1/chat/completions';
      default:
        return 'https://api.openai.com/v1/chat/completions';
    }
  }

  /**
   * Call the AI provider with a prompt and return the response text
   */
  async function chat(systemPrompt, userPrompt, maxTokens = 1000) {
    if (!isConfigured()) {
      throw new Error('AI not configured. Click Settings to add your API key.');
    }

    const endpoint = getApiEndpoint();

    if (config.provider === 'anthropic') {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`AI API error (${response.status}): ${err}`);
      }
      const data = await response.json();
      return data.content?.[0]?.text || '';
    }

    // OpenAI-compatible
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`AI API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // ─── Built-in heuristics (no AI required) ─────────────────────

  /**
   * Diagnose a gRPC error using built-in knowledge
   */
  function diagnoseError(request) {
    const insights = [];

    if (!request.grpcStatus && !request.error) {
      if (request.responseStatus === 200) {
        insights.push({
          level: 'success',
          title: 'Request completed',
          detail: 'The gRPC call returned successfully with status OK.',
        });
      }
      return insights;
    }

    if (request.error || request.responseStatus === 0) {
      insights.push({
        level: 'error',
        title: 'Network error',
        detail: 'The request failed to complete. This usually means the server is unreachable, CORS is blocking the request, or the connection was refused. Check: 1) Is the backend running? 2) Are CORS headers configured for gRPC? 3) Is the gRPC endpoint URL correct?',
      });
      return insights;
    }

    if (request.grpcStatus) {
      const statusInfo = GRPC_STATUS_CODES[request.grpcStatus.code];
      if (statusInfo) {
        const level = request.grpcStatus.code === 0 ? 'success' : 'error';
        insights.push({
          level,
          title: `${statusInfo.name} (code ${request.grpcStatus.code})`,
          detail: statusInfo.description,
        });

        // Add specific advice for common errors
        switch (request.grpcStatus.code) {
          case 4: // DEADLINE_EXCEEDED
            insights.push({
              level: 'warning',
              title: 'Possible timeout',
              detail: `Request took ${request.duration?.toFixed(0)}ms. Consider increasing the deadline or optimizing the server handler.`,
            });
            break;
          case 7: // PERMISSION_DENIED
            insights.push({
              level: 'warning',
              title: 'Auth issue',
              detail: 'Check if the auth token is expired or missing in the request metadata/headers.',
            });
            break;
          case 8: // RESOURCE_EXHAUSTED
            insights.push({
              level: 'warning',
              title: 'Rate limited',
              detail: 'The server is rate-limiting or out of resources. Check if you are making too many requests.',
            });
            break;
          case 14: // UNAVAILABLE
            insights.push({
              level: 'error',
              title: 'Service unavailable',
              detail: 'The server may be overloaded or restarting. This is often transient — retry with backoff.',
            });
            break;
          case 16: // UNAUTHENTICATED
            insights.push({
              level: 'warning',
              title: 'Authentication required',
              detail: 'The request lacks valid credentials. Check for missing or invalid Authorization/token headers.',
            });
            break;
        }
      }

      if (request.grpcStatus.message) {
        insights.push({
          level: 'info',
          title: 'Error message',
          detail: request.grpcStatus.message,
        });
      }
    }

    if (request.responseStatus && request.responseStatus >= 400) {
      insights.push({
        level: 'error',
        title: `HTTP ${request.responseStatus}`,
        detail: `The server returned HTTP status ${request.responseStatus}. This may indicate a gateway/proxy issue rather than a gRPC-level problem.`,
      });
    }

    return insights;
  }

  /**
   * Generate a quick summary of a request/response
   */
  function quickSummary(request) {
    const parts = [];

    if (request.serviceName && request.methodName) {
      parts.push(`${request.serviceName}/${request.methodName}`);
    }

    if (request.grpcStatus) {
      const info = GRPC_STATUS_CODES[request.grpcStatus.code];
      parts.push(info ? info.name : `code ${request.grpcStatus.code}`);
    }

    if (request.duration != null) {
      parts.push(`${request.duration.toFixed(0)}ms`);
    }

    // Summarize request payload
    if (request.requestFrames && request.requestFrames.length > 0) {
      const decoded = typeof decodeBase64Proto === 'function'
        ? decodeBase64Proto(request.requestFrames[0].data)
        : null;
      if (decoded && typeof summarizeDecoded === 'function') {
        const summary = summarizeDecoded(decoded);
        if (summary && summary !== '...') {
          parts.push(`req: ${summary.substring(0, 60)}`);
        }
      }
    }

    // Summarize response payload
    if (request.responseFrames && request.responseFrames.length > 0) {
      const decoded = typeof decodeBase64Proto === 'function'
        ? decodeBase64Proto(request.responseFrames[0].data)
        : null;
      if (decoded && typeof summarizeDecoded === 'function') {
        const summary = summarizeDecoded(decoded);
        if (summary && summary !== '...') {
          parts.push(`res: ${summary.substring(0, 60)}`);
        }
      }
    }

    return parts.join(' | ');
  }

  // ─── AI-powered features ──────────────────────────────────────

  /**
   * AI: Diagnose a request with deep analysis
   */
  async function aiDiagnose(request) {
    const systemPrompt = `You are a gRPC debugging expert. Analyze the gRPC request and response data provided. Identify issues, explain what happened, and suggest fixes. Be concise and specific. Format as JSON: { "insights": [{ "level": "error|warning|info|success", "title": "...", "detail": "..." }] }`;

    const reqPayload = request.requestFrames?.[0]
      ? JSON.stringify(decodeBase64Proto(request.requestFrames[0].data), null, 2)
      : '(empty)';

    const resPayload = request.responseFrames?.[0]
      ? JSON.stringify(decodeBase64Proto(request.responseFrames[0].data), null, 2)
      : '(empty)';

    const userPrompt = `gRPC Request:
URL: ${request.url}
Service: ${request.serviceName}/${request.methodName}
Duration: ${request.duration?.toFixed(0)}ms
HTTP Status: ${request.responseStatus}
gRPC Status: ${request.grpcStatus ? `code ${request.grpcStatus.code} (${GRPC_STATUS_CODES[request.grpcStatus.code]?.name || 'unknown'}): ${request.grpcStatus.message || ''}` : 'OK'}

Request payload (decoded protobuf):
${reqPayload}

Response payload (decoded protobuf):
${resPayload}

Request headers:
${JSON.stringify(request.requestHeaders || {}, null, 2)}`;

    const result = await chat(systemPrompt, userPrompt, 1500);
    try {
      const parsed = JSON.parse(result);
      return parsed.insights || [];
    } catch {
      return [{ level: 'info', title: 'AI Analysis', detail: result }];
    }
  }

  /**
   * AI: Generate a natural language summary
   */
  async function aiSummarize(request) {
    const systemPrompt = 'You are a gRPC expert. Provide a concise summary of this gRPC request and response. Focus on what was requested, what was returned, and any notable details. Keep it under 3 sentences.';

    const reqPayload = request.requestFrames?.[0]
      ? JSON.stringify(decodeBase64Proto(request.requestFrames[0].data), null, 2)
      : '(empty)';

    const resPayload = request.responseFrames?.[0]
      ? JSON.stringify(decodeBase64Proto(request.responseFrames[0].data), null, 2)
      : '(empty)';

    const userPrompt = `Service: ${request.serviceName}/${request.methodName}
Status: ${request.grpcStatus ? `code ${request.grpcStatus.code}` : 'OK'}
Duration: ${request.duration?.toFixed(0)}ms

Request:
${reqPayload}

Response:
${resPayload}`;

    return await chat(systemPrompt, userPrompt, 500);
  }

  /**
   * AI: Generate replay code (curl, ghz, JS/Python client)
   */
  async function aiGenerateReplay(request) {
    const systemPrompt = `You are a gRPC expert. Generate runnable code to replay this gRPC request. Provide the code in a single code block. Use curl with grpcurl if possible, or a simple Node.js/Python script. Include the decoded payload as a comment.`;

    const reqPayload = request.requestFrames?.[0]
      ? JSON.stringify(decodeBase64Proto(request.requestFrames[0].data), null, 2)
      : '(empty)';

    const userPrompt = `URL: ${request.url}
Service: ${request.serviceName}/${request.methodName}
Content-Type: ${request.requestHeaders['content-type'] || 'application/grpc-web+proto'}

Request headers:
${JSON.stringify(request.requestHeaders || {}, null, 2)}

Decoded request payload:
${reqPayload}`;

    return await chat(systemPrompt, userPrompt, 1000);
  }

  /**
   * AI: Natural language search across requests
   */
  async function aiSearch(query, requests) {
    const systemPrompt = `You are a gRPC debugging assistant. The user wants to filter gRPC requests using natural language. Return a JSON array of request IDs that match the query. Only return IDs from the provided list.

Format: { "matchingIds": ["id1", "id2", ...] }`;

    const requestSummaries = requests.map(r => ({
      id: r.id,
      service: `${r.serviceName}/${r.methodName}`,
      status: r.grpcStatus?.code ?? 'ok',
      duration: r.duration?.toFixed(0) + 'ms',
      summary: quickSummary(r),
    }));

    const userPrompt = `Query: "${query}"

Requests:
${JSON.stringify(requestSummaries, null, 2)}`;

    const result = await chat(systemPrompt, userPrompt, 800);
    try {
      const parsed = JSON.parse(result);
      return parsed.matchingIds || [];
    } catch {
      return [];
    }
  }

  /**
   * AI: Infer proto schema from decoded data
   */
  async function aiInferSchema(request) {
    const systemPrompt = `You are a protobuf expert. Based on the decoded protobuf field data, infer a reasonable .proto schema. Assign meaningful field names based on the context (service name, method name, field values). Output only the proto definition in a code block.`;

    const reqFields = request.requestFrames?.[0]
      ? JSON.stringify(decodeBase64Proto(request.requestFrames[0].data), null, 2)
      : '{}';

    const resFields = request.responseFrames?.[0]
      ? JSON.stringify(decodeBase64Proto(request.responseFrames[0].data), null, 2)
      : '{}';

    const userPrompt = `Service: ${request.serviceName}
Method: ${request.methodName}

Decoded request fields:
${reqFields}

Decoded response fields:
${resFields}`;

    return await chat(systemPrompt, userPrompt, 1000);
  }

  return {
    loadConfig,
    saveConfig,
    getConfig,
    isConfigured,
    chat,
    diagnoseError,
    quickSummary,
    aiDiagnose,
    aiSummarize,
    aiGenerateReplay,
    aiSearch,
    aiInferSchema,
    GRPC_STATUS_CODES,
  };
})();
