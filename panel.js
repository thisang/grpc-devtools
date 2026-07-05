/**
 * DevTools panel logic
 * Manages request list, detail view, and AI sidebar
 */

(function () {
  'use strict';

  // ─── Global error handler ─────────────────────────────
  window.addEventListener('error', function (e) {
    console.error('[gRPC DevTools] PANEL JS ERROR:', e.message, 'at', e.filename, ':', e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    console.error('[gRPC DevTools] PANEL PROMISE REJECTION:', e.reason);
  });

  // ─── GrpcAI fallback (in case ai.js failed to load) ──
  if (typeof GrpcAI === 'undefined') {
    console.warn('[gRPC DevTools] GrpcAI not loaded, using fallback');
    window.GrpcAI = {
      GRPC_STATUS_CODES: {
        0: { name: 'OK' }, 1: { name: 'CANCELLED' }, 2: { name: 'UNKNOWN' },
        3: { name: 'INVALID_ARGUMENT' }, 4: { name: 'DEADLINE_EXCEEDED' },
        5: { name: 'NOT_FOUND' }, 6: { name: 'ALREADY_EXISTS' },
        7: { name: 'PERMISSION_DENIED' }, 8: { name: 'RESOURCE_EXHAUSTED' },
        9: { name: 'ABORTED' }, 10: { name: 'OUT_OF_RANGE' },
        11: { name: 'UNIMPLEMENTED' }, 12: { name: 'INTERNAL' },
        13: { name: 'UNAVAILABLE' }, 14: { name: 'DATA_LOSS' }, 15: { name: 'UNAUTHENTICATED' },
      },
      quickSummary: function () { return ''; },
      diagnoseError: function () { return []; },
      isConfigured: function () { return false; },
    };
  }

  // ─── State ────────────────────────────────────────────────────

  let requests = [];
  let selectedRequestId = null;
  let recording = true;
  let activeTab = 'request'; // request | response | headers | raw
  let panelPort = null;

  // ─── DOM elements ─────────────────────────────────────────────

  const requestList = document.getElementById('requestList');
  const detailPanel = document.getElementById('detailPanel');
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearBtn');
  const exportBtn = document.getElementById('exportBtn');
  const aiSearchBtn = document.getElementById('aiSearchBtn');
  const recordToggle = document.getElementById('recordToggle');
  const requestCount = document.getElementById('requestCount');
  const aiContent = document.getElementById('aiContent');
  const aiActions = document.getElementById('aiActions');
  const aiConfigBtn = document.getElementById('aiConfigBtn');
  const aiModal = document.getElementById('aiModal');
  const aiModalCancel = document.getElementById('aiModalCancel');
  const aiModalSave = document.getElementById('aiModalSave');

  // ─── Connect to background ────────────────────────────────────
  //
  // Push-based architecture: no polling.
  //   - port.onMessage: real-time updates (new-request, cleared, init)
  //   - port.onDisconnect: auto-reconnect (SW was killed → restart → init with full snapshot)

  const tabId = chrome.devtools.inspectedWindow.tabId;
  console.log('[gRPC DevTools] Panel init, tabId:', tabId);

  let reconnectTimer = null;
  let reconnectDelay = 500; // start at 500ms, back off on repeated failures

  function connectPort() {
    console.log('[gRPC DevTools] Panel connecting...');
    panelPort = chrome.runtime.connect({ name: 'grpc-panel-' + tabId });

    panelPort.onMessage.addListener((msg) => {
      console.log('[gRPC DevTools] Panel port message:', msg.type, '| requests:', msg.requests?.length);

      if (msg.type === 'init') {
        const serverRequests = msg.requests || [];
        console.log('[gRPC DevTools] Panel init: received', serverRequests.length, 'requests');
        requests = serverRequests;
        renderRequestList();
        updateCount();
      } else if (msg.type === 'new-request') {
        if (recording) {
          requests.push(msg.request);
          renderRequestList();
          updateCount();
        }
      } else if (msg.type === 'cleared') {
        requests = [];
        renderRequestList();
        updateCount();
        renderDetail(null);
        renderAiInsights(null);
      }
    });

    panelPort.onDisconnect.addListener(() => {
      console.log('[gRPC DevTools] Panel port disconnected (SW may have been killed), reconnecting...');
      panelPort = null;

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 3000);
        connectPort();
      }, reconnectDelay);
    });

    reconnectDelay = 500;
  }

  connectPort();

  // ─── Load AI config ───────────────────────────────────────────

  GrpcAI.loadConfig();

  // ─── Render functions ─────────────────────────────────────────

  function renderRequestList() {
    try {
      if (requests.length === 0) {
        requestList.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">gRPC</div>
            <p>No gRPC requests captured yet</p>
            <p class="hint">Make sure the page is making gRPC / gRPC-Web calls.</p>
          </div>
        `;
        return;
      }

      const html = requests.map(req => {
        const isSelected = req.id === selectedRequestId;
        const isError = req.error || (req.grpcStatus && req.grpcStatus.code !== 0) || (req.responseStatus >= 400);
        const isSuccess = !isError && req.grpcStatus?.code === 0;
        const statusClass = isError ? 'error' : isSuccess ? 'success' : '';
        const statusBadgeClass = isError ? 'error' : isSuccess ? 'ok' : 'pending';

        let statusText = 'OK';
        if (req.error) {
          statusText = 'ERR';
        } else if (req.grpcStatus) {
          const info = GrpcAI.GRPC_STATUS_CODES[req.grpcStatus.code];
          statusText = info ? info.name : ('c' + req.grpcStatus.code);
        } else if (req.responseStatus >= 400) {
          statusText = String(req.responseStatus);
        }

        return `
          <div class="request-item ${statusClass} ${isSelected ? 'selected' : ''}" data-id="${req.id}">
            <div class="request-item-header">
              <span class="request-method">${req.method || 'POST'}</span>
              <span class="request-name">${escapeHtml(req.serviceName + '/' + req.methodName)}</span>
              <span class="request-status ${statusBadgeClass}">${statusText}</span>
            </div>
            <div class="request-url">${escapeHtml(req.url)}</div>
            <div class="request-meta">
              <span>${req.duration != null ? req.duration.toFixed(0) : '?'}ms</span>
              <span>${(req.responseFrames || []).length} frames</span>
            </div>
          </div>
        `;
      }).join('');

      requestList.innerHTML = html;

      // Attach click handlers
      requestList.querySelectorAll('.request-item').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.dataset.id;
          selectedRequestId = id;
          const req = requests.find(r => r.id === id);
          renderRequestList();
          renderDetail(req);
          renderAiInsights(req);
        });
      });
    } catch (e) {
      console.error('[gRPC DevTools] renderRequestList error:', e);
      requestList.innerHTML = `<div class="empty-state"><p>Render error: ${escapeHtml(e.message)}</p></div>`;
    }
  }

  function renderDetail(req) {
    try {
      if (!req) {
        detailPanel.innerHTML = `<div class="empty-state"><p>Select a request to view details</p></div>`;
        return;
      }

      const reqDecoded = req.requestFrames?.length > 0
        ? decodeBase64Proto(req.requestFrames[0].data)
        : null;
      const resDecoded = req.responseFrames?.length > 0
        ? decodeBase64Proto(req.responseFrames[0].data)
        : null;

      detailPanel.innerHTML = `
        <div class="detail-header">
          <div class="detail-title">${escapeHtml(req.serviceName)} / ${escapeHtml(req.methodName)}</div>
          <div class="detail-url">${escapeHtml(req.url)}</div>
        </div>
        <div class="detail-tabs">
          <div class="detail-tab ${activeTab === 'request' ? 'active' : ''}" data-tab="request">Request</div>
          <div class="detail-tab ${activeTab === 'response' ? 'active' : ''}" data-tab="response">Response</div>
          <div class="detail-tab ${activeTab === 'headers' ? 'active' : ''}" data-tab="headers">Headers</div>
          <div class="detail-tab ${activeTab === 'raw' ? 'active' : ''}" data-tab="raw">Raw</div>
        </div>
        <div class="detail-content" id="detailContent"></div>
      `;

      detailPanel.querySelectorAll('.detail-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          activeTab = tab.dataset.tab;
          detailPanel.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          renderTabContent(req, reqDecoded, resDecoded);
        });
      });

      renderTabContent(req, reqDecoded, resDecoded);
    } catch (e) {
      console.error('[gRPC DevTools] renderDetail error:', e);
    }
  }

  function renderTabContent(req, reqDecoded, resDecoded) {
    const content = document.getElementById('detailContent');
    if (!content) return;

    try {
      if (activeTab === 'request') {
        content.innerHTML = `
          <div class="section-title">Decoded request payload</div>
          ${reqDecoded ? renderJson(reqDecoded) : '<p class="ai-placeholder">No request body</p>'}
          ${(req.requestFrames || []).length > 1 ? `<div class="section-title">Additional frames (${(req.requestFrames || []).length - 1} more)</div>` : ''}
        `;
      } else if (activeTab === 'response') {
        let grpcInfo = '';
        if (req.grpcStatus) {
          const isOk = req.grpcStatus.code === 0;
          grpcInfo = `<div class="ai-insight ${isOk ? 'success' : 'error'}">
            <div class="ai-insight-title">gRPC Status: ${GrpcAI.GRPC_STATUS_CODES[req.grpcStatus.code]?.name || 'Unknown'} (code ${req.grpcStatus.code})</div>
            ${req.grpcStatus.message ? `<div>${escapeHtml(req.grpcStatus.message)}</div>` : ''}
          </div>`;
        }

        content.innerHTML = `
          ${grpcInfo}
          <div class="section-title">Decoded response payload</div>
          ${resDecoded ? renderJson(resDecoded) : '<p class="ai-placeholder">No response body</p>'}
          ${(req.responseFrames || []).length > 1 ? `<div class="section-title">Additional frames (${(req.responseFrames || []).length - 1} more)</div>` : ''}
        `;
      } else if (activeTab === 'headers') {
        content.innerHTML = `
          <div class="section-title">Request headers</div>
          <table class="headers-table">
            ${Object.entries(req.requestHeaders || {}).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('') || '<tr><td colspan="2">No headers</td></tr>'}
          </table>
          <div class="section-title">Response headers</div>
          <table class="headers-table">
            ${Object.entries(req.responseHeaders || {}).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('') || '<tr><td colspan="2">No headers</td></tr>'}
          </table>
        `;
      } else if (activeTab === 'raw') {
        content.innerHTML = `
          <div class="section-title">Request frames (base64)</div>
          ${(req.requestFrames || []).map((f, i) => `
            <div class="frame-item">
              <div class="frame-label">Frame ${i + 1}${f.compressed ? ' (compressed)' : ''}${f.truncated ? ' (truncated)' : ''}</div>
              <div class="raw-hex">${escapeHtml(f.data.substring(0, 500))}${f.data.length > 500 ? '...' : ''}</div>
            </div>
          `).join('') || '<p class="ai-placeholder">No request frames</p>'}
          <div class="section-title">Response frames (base64)</div>
          ${(req.responseFrames || []).map((f, i) => `
            <div class="frame-item">
              <div class="frame-label">Frame ${i + 1}${f.compressed ? ' (compressed)' : ''}${f.truncated ? ' (truncated)' : ''}</div>
              <div class="raw-hex">${escapeHtml(f.data.substring(0, 500))}${f.data.length > 500 ? '...' : ''}</div>
            </div>
          `).join('') || '<p class="ai-placeholder">No response frames</p>'}
        `;
      }
    } catch (e) {
      console.error('[gRPC DevTools] renderTabContent error:', e);
    }
  }

  function renderJson(obj) {
    try {
      const jsonStr = JSON.stringify(obj, null, 2);
      // Escape HTML entities first
      let safe = jsonStr
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Syntax highlight
      safe = safe.replace(/("(?:\\[\s\S])*?")\s*:/g, '<span class="json-key">$1</span>:')
        .replace(/"([^"]*)"/g, '<span class="json-string">"$1"</span>')
        .replace(/\b(true|false)\b/g, '<span class="json-bool">$1</span>')
        .replace(/\bnull\b/g, '<span class="json-null">null</span>')
        .replace(/\b(\d+(\.\d+)?)\b/g, '<span class="json-number">$1</span>');

      return `<div class="json-viewer">${safe}</div>`;
    } catch (e) {
      return `<div class="ai-placeholder">JSON encode error: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ─── AI sidebar ───────────────────────────────────────────────

  function renderAiInsights(req) {
    try {
      if (!req) {
        aiContent.innerHTML = '<p class="ai-placeholder">AI-powered debugging insights will appear here. Select a request to get started.</p>';
        aiActions.style.display = 'none';
        return;
      }

      const insights = GrpcAI.diagnoseError(req);
      aiContent.innerHTML = insights.map(insight => `
        <div class="ai-insight ${insight.level}">
          <div class="ai-insight-title">${escapeHtml(insight.title)}</div>
          <div>${escapeHtml(insight.detail)}</div>
        </div>
      `).join('');

      aiActions.style.display = 'flex';
      aiActions.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => handleAiAction(btn.dataset.action, req);
      });
    } catch (e) {
      console.error('[gRPC DevTools] renderAiInsights error:', e);
    }
  }

  async function handleAiAction(action, req) {
    if (!GrpcAI.isConfigured()) {
      aiContent.innerHTML = '<div class="ai-insight warning"><div class="ai-insight-title">AI not configured</div><div>Click Settings to configure your AI API key.</div></div>';
      return;
    }

    aiContent.innerHTML = '<div class="ai-loading">Analyzing...</div>';

    try {
      if (action === 'diagnose') {
        const insights = await GrpcAI.aiDiagnose(req);
        aiContent.innerHTML = insights.map(insight => `
          <div class="ai-insight ${insight.level}">
            <div class="ai-insight-title">${escapeHtml(insight.title)}</div>
            <div>${escapeHtml(insight.detail)}</div>
          </div>
        `).join('');
      } else if (action === 'summarize') {
        const summary = await GrpcAI.aiSummarize(req);
        aiContent.innerHTML = `<div class="ai-insight info"><div>${escapeHtml(summary)}</div></div>`;
      } else if (action === 'replay') {
        const code = await GrpcAI.aiGenerateReplay(req);
        aiContent.innerHTML = `<div class="ai-insight info"><div class="ai-insight-title">Replay code</div><pre class="json-viewer">${escapeHtml(code)}</pre></div>`;
      }
    } catch (e) {
      aiContent.innerHTML = `<div class="ai-insight error"><div class="ai-insight-title">AI Error</div><div>${escapeHtml(e.message)}</div></div>`;
    }
  }

  // ─── AI config modal ──────────────────────────────────────────

  aiConfigBtn.addEventListener('click', () => {
    const config = GrpcAI.getConfig();
    document.getElementById('aiProvider').value = config.provider;
    document.getElementById('aiApiKey').value = config.apiKey;
    document.getElementById('aiModel').value = config.model;
    document.getElementById('aiBaseUrl').value = config.baseUrl;
    aiModal.style.display = 'flex';
  });

  aiModalCancel.addEventListener('click', () => {
    aiModal.style.display = 'none';
  });

  aiModalSave.addEventListener('click', () => {
    GrpcAI.saveConfig({
      provider: document.getElementById('aiProvider').value,
      apiKey: document.getElementById('aiApiKey').value,
      model: document.getElementById('aiModel').value,
      baseUrl: document.getElementById('aiBaseUrl').value,
    });
    aiModal.style.display = 'none';
  });

  // ─── Toolbar actions ──────────────────────────────────────────

  clearBtn.addEventListener('click', () => {
    const tabId = chrome.devtools.inspectedWindow.tabId;
    chrome.runtime.sendMessage({ type: 'clear-requests', tabId });
    requests = [];
    renderRequestList();
    updateCount();
    renderDetail(null);
    renderAiInsights(null);
  });

  exportBtn.addEventListener('click', () => {
    const json = JSON.stringify(requests, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `grpc-requests-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  recordToggle.addEventListener('change', (e) => {
    recording = e.target.checked;
  });

  aiSearchBtn.addEventListener('click', async () => {
    const query = searchInput.value.trim();
    if (!query) return;

    if (!GrpcAI.isConfigured()) {
      filterRequests(query);
      return;
    }

    aiContent.innerHTML = '<div class="ai-loading">Searching...</div>';
    try {
      const matchingIds = await GrpcAI.aiSearch(query, requests);
      requestList.querySelectorAll('.request-item').forEach(el => {
        if (matchingIds.includes(el.dataset.id)) {
          el.style.outline = '2px solid var(--accent)';
        } else {
          el.style.outline = '';
        }
      });
      aiContent.innerHTML = `<div class="ai-insight info"><div>Found ${matchingIds.length} matching requests</div></div>`;
    } catch (e) {
      aiContent.innerHTML = `<div class="ai-insight error"><div>Search failed: ${escapeHtml(e.message)}</div></div>`;
    }
  });

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim().toLowerCase();
    if (!query) {
      requestList.querySelectorAll('.request-item').forEach(el => {
        el.style.display = '';
        el.style.outline = '';
      });
      return;
    }
    filterRequests(query);
  });

  function filterRequests(query) {
    requestList.querySelectorAll('.request-item').forEach(el => {
      const text = el.textContent.toLowerCase();
      el.style.display = text.includes(query) ? '' : 'none';
    });
  }

  // ─── Utils ────────────────────────────────────────────────────

  function updateCount() {
    requestCount.textContent = String(requests.length);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Load CSS via JS (panel.html can't use <link> in some contexts)
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'panel.css';
  document.head.appendChild(link);

  console.log('[gRPC DevTools] Panel initialized OK');
})();
