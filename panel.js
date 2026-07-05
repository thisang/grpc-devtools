/**
 * DevTools panel logic
 * Manages request list, detail view, and AI sidebar
 */

(function () {
  'use strict';

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
      console.log('[gRPC DevTools] Panel port message:', msg.type);

      if (msg.type === 'init') {
        // Full snapshot from background (on connect or after SW restart)
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

      // Auto-reconnect with backoff.
      // On reconnect, background sends 'init' with full snapshot from
      // chrome.storage.session, so no data is lost.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 3000); // cap at 3s
        connectPort();
      }, reconnectDelay);
    });

    // Reset backoff on successful connect
    reconnectDelay = 500;
  }

  connectPort();

  // ─── Load AI config ───────────────────────────────────────────

  GrpcAI.loadConfig();

  // ─── Render functions ─────────────────────────────────────────

  function renderRequestList() {
    if (requests.length === 0) {
      requestList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">gRPC</div>
          <p>No gRPC requests captured yet</p>
          <p class="hint">Make sure the page is making gRPC / gRPC-Web calls. The extension automatically intercepts fetch and XHR traffic.</p>
        </div>
      `;
      return;
    }

    const html = requests.map(req => {
      const isSelected = req.id === selectedRequestId;
      const isError = req.error || (req.grpcStatus && req.grpcStatus.code !== 0) || (req.responseStatus >= 400);
      const isSuccess = !isError && req.grpcStatus?.code === 0;
      const statusClass = isError ? 'error' : isSuccess ? 'success' : '';
      const statusText = req.error
        ? 'ERR'
        : req.grpcStatus
          ? GrpcAI.GRPC_STATUS_CODES[req.grpcStatus.code]?.name || `c${req.grpcStatus.code}`
          : req.responseStatus >= 400 ? `${req.responseStatus}` : 'OK';
      const statusBadgeClass = isError ? 'error' : isSuccess ? 'ok' : 'pending';

      const summary = GrpcAI.quickSummary(req);

      return `
        <div class="request-item ${statusClass} ${isSelected ? 'selected' : ''}" data-id="${req.id}">
          <div class="request-item-header">
            <span class="request-method">${req.method || 'POST'}</span>
            <span class="request-name">${req.serviceName}/${req.methodName}</span>
            <span class="request-status ${statusBadgeClass}">${statusText}</span>
          </div>
          <div class="request-url">${escapeHtml(req.url)}</div>
          <div class="request-meta">
            <span>${req.duration?.toFixed(0) || '?'}ms</span>
            <span>${req.responseFrames?.length || 0} frames</span>
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
  }

  function renderDetail(req) {
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

    // Tab switching
    detailPanel.querySelectorAll('.detail-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        detailPanel.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderTabContent(req, reqDecoded, resDecoded);
      });
    });

    renderTabContent(req, reqDecoded, resDecoded);
  }

  function renderTabContent(req, reqDecoded, resDecoded) {
    const content = document.getElementById('detailContent');
    if (!content) return;

    if (activeTab === 'request') {
      content.innerHTML = `
        <div class="section-title">Decoded request payload</div>
        ${reqDecoded ? renderJson(reqDecoded) : '<p class="ai-placeholder">No request body</p>'}
        ${req.requestFrames?.length > 1 ? `<div class="section-title">Additional frames (${req.requestFrames.length - 1} more)</div>` : ''}
      `;
    } else if (activeTab === 'response') {
      const grpcInfo = req.grpcStatus
        ? `<div class="ai-insight ${req.grpcStatus.code === 0 ? 'success' : 'error'}">
            <div class="ai-insight-title">gRPC Status: ${GrpcAI.GRPC_STATUS_CODES[req.grpcStatus.code]?.name || 'Unknown'} (code ${req.grpcStatus.code})</div>
            ${req.grpcStatus.message ? `<div>${escapeHtml(req.grpcStatus.message)}</div>` : ''}
          </div>`
        : '';

      content.innerHTML = `
        ${grpcInfo}
        <div class="section-title">Decoded response payload</div>
        ${resDecoded ? renderJson(resDecoded) : '<p class="ai-placeholder">No response body</p>'}
        ${req.responseFrames?.length > 1 ? `<div class="section-title">Additional frames (${req.responseFrames.length - 1} more)</div>` : ''}
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
  }

  function renderJson(obj, indent = 0) {
    const jsonStr = JSON.stringify(obj, null, 2);
    const highlighted = jsonStr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
        let cls = 'json-number';
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'json-key';
          } else {
            cls = 'json-string';
          }
        } else if (/true|false/.test(match)) {
          cls = 'json-bool';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      });

    return `<div class="json-viewer">${highlighted}</div>`;
  }

  // ─── AI sidebar ───────────────────────────────────────────────

  function renderAiInsights(req) {
    if (!req) {
      aiContent.innerHTML = '<p class="ai-placeholder">AI-powered debugging insights will appear here. Select a request to get started.</p>';
      aiActions.style.display = 'none';
      return;
    }

    // Show built-in diagnostics immediately
    const insights = GrpcAI.diagnoseError(req);
    aiContent.innerHTML = insights.map(insight => `
      <div class="ai-insight ${insight.level}">
        <div class="ai-insight-title">${escapeHtml(insight.title)}</div>
        <div>${escapeHtml(insight.detail)}</div>
      </div>
    `).join('');

    aiActions.style.display = 'flex';

    // Attach action handlers
    aiActions.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => handleAiAction(btn.dataset.action, req);
    });
  }

  async function handleAiAction(action, req) {
    if (!GrpcAI.isConfigured()) {
      aiContent.innerHTML = '<div class="ai-insight warning"><div class="ai-insight-title">AI not configured</div><div>Click Settings to configure your AI API key for advanced features.</div></div>';
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

  // AI search
  aiSearchBtn.addEventListener('click', async () => {
    const query = searchInput.value.trim();
    if (!query) return;

    if (!GrpcAI.isConfigured()) {
      // Fall back to simple text search
      filterRequests(query);
      return;
    }

    aiContent.innerHTML = '<div class="ai-loading">Searching...</div>';
    try {
      const matchingIds = await GrpcAI.aiSearch(query, requests);
      // Highlight matching requests
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

  // Fix: panel.html uses <style src=...>, need to load CSS via JS
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'panel.css';
  document.head.appendChild(link);

  console.log('[gRPC DevTools] Panel initialized');
})();
