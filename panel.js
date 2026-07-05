/**
 * DevTools panel logic
 * Manages request list, detail view, and AI sidebar
 *
 * Connection strategy:
 *   1. Primary: port.postMessage (real-time push from background)
 *   2. Fallback: chrome.storage.session polling (survives SW restarts)
 *   3. On port reconnect → receives full snapshot via 'init' message
 */
(function () {
  'use strict';

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
      loadConfig: function () {},
      getConfig: function () { return {}; },
      saveConfig: function () {},
    };
  }

  // ─── State ────────────────────────────────────────────────────
  let requests = [];
  let selectedRequestId = null;
  let recording = true;
  let activeTab = 'request';
  let panelPort = null;
  let tabId = null;
  let reconnectTimer = null;
  let reconnectDelay = 500;
  let pollTimer = null;

  // ─── DOM refs (populated after DOMContentLoaded) ──────────────
  let requestList, detailPanel, searchInput, clearBtn, exportBtn;
  let aiSearchBtn, recordToggle, requestCount, aiContent, aiActions;
  let aiConfigBtn, aiModal, aiModalCancel, aiModalSave, statusBar;

  // ─── Status bar ───────────────────────────────────────────────
  function setStatus(state, text) {
    if (!statusBar) return;
    statusBar.className = 'status-bar status-' + state;
    var dot = statusBar.querySelector('.status-dot');
    var label = statusBar.querySelector('.status-text');
    if (dot) dot.className = 'status-dot';
    if (label) label.textContent = text;
  }

  // ─── Connection ───────────────────────────────────────────────
  function connectPort() {
    if (!tabId) {
      console.error('[gRPC DevTools] No tabId, cannot connect');
      return;
    }

    setStatus('connecting', 'Connecting...');
    console.log('[gRPC DevTools] Panel connecting to tab', tabId);

    try {
      panelPort = chrome.runtime.connect({ name: 'grpc-panel-' + tabId });

      if (chrome.runtime.lastError) {
        console.error('[gRPC DevTools] connect() failed:', chrome.runtime.lastError.message);
        setStatus('error', 'Connection failed: ' + chrome.runtime.lastError.message);
        scheduleReconnect();
        startPolling(); // fallback to polling
        return;
      }
    } catch (e) {
      console.error('[gRPC DevTools] connect() threw:', e);
      setStatus('error', 'Connection error: ' + e.message);
      scheduleReconnect();
      startPolling();
      return;
    }

    panelPort.onMessage.addListener(function (msg) {
      try {
        console.log('[gRPC DevTools] Panel port message:', msg.type, '| requests:', msg.requests ? msg.requests.length : 'N/A');

        if (msg.type === 'init') {
          var serverRequests = msg.requests || [];
          console.log('[gRPC DevTools] Panel init: received', serverRequests.length, 'requests');
          requests = serverRequests;
          renderRequestList();
          updateCount();
          setStatus('connected', 'Connected — ' + serverRequests.length + ' requests loaded');
          stopPolling(); // port is alive, no need to poll
        } else if (msg.type === 'new-request') {
          if (recording) {
            requests.push(msg.request);
            renderRequestList();
            updateCount();
            setStatus('connected', 'Connected — ' + requests.length + ' requests');
          }
        } else if (msg.type === 'cleared') {
          requests = [];
          renderRequestList();
          updateCount();
          renderDetail(null);
          renderAiInsights(null);
          setStatus('connected', 'Connected — cleared');
        }
      } catch (e) {
        console.error('[gRPC DevTools] Error handling port message:', e);
      }
    });

    panelPort.onDisconnect.addListener(function () {
      console.log('[gRPC DevTools] Panel port disconnected');
      panelPort = null;
      setStatus('connecting', 'Disconnected — reconnecting...');
      scheduleReconnect();
      startPolling(); // port is dead, fall back to polling
    });

    reconnectDelay = 500;
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
      connectPort();
    }, reconnectDelay);
  }

  // ─── Polling fallback (only active when port is dead) ─────────
  function startPolling() {
    if (pollTimer) return;
    console.log('[gRPC DevTools] Starting storage polling fallback');
    pollTimer = setInterval(pollRequests, 2000);
    pollRequests(); // immediate first poll
  }

  function stopPolling() {
    if (pollTimer) {
      console.log('[gRPC DevTools] Stopping storage polling (port is alive)');
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollRequests() {
    if (!tabId) return;
    var key = 'tab-' + tabId;

    chrome.storage.session.get(key, function (result) {
      if (chrome.runtime.lastError) {
        console.warn('[gRPC DevTools] storage.session.get failed:', chrome.runtime.lastError.message);
        return;
      }
      var serverRequests = result[key];
      if (!serverRequests) return;

      if (serverRequests.length !== requests.length) {
        console.log('[gRPC DevTools] Poll: ' + requests.length + ' → ' + serverRequests.length + ' requests');
        requests = serverRequests;
        renderRequestList();
        updateCount();
        setStatus('connected', 'Polling — ' + requests.length + ' requests');
      }
    });
  }

  // ─── Render functions ─────────────────────────────────────────
  function renderRequestList() {
    try {
      if (!requestList) return;
      if (requests.length === 0) {
        requestList.innerHTML =
          '<div class="empty-state">' +
            '<div class="empty-icon">gRPC</div>' +
            '<p>No gRPC requests captured yet</p>' +
            '<p class="hint">Make sure the page is making gRPC / gRPC-Web calls.</p>' +
          '</div>';
        return;
      }

      var html = requests.map(function (req) {
        var isSelected = req.id === selectedRequestId;
        var isError = req.error || (req.grpcStatus && req.grpcStatus.code !== 0) || (req.responseStatus >= 400);
        var isSuccess = !isError && req.grpcStatus && req.grpcStatus.code === 0;
        var statusClass = isError ? 'error' : isSuccess ? 'success' : '';
        var statusBadgeClass = isError ? 'error' : isSuccess ? 'ok' : 'pending';

        var statusText = 'OK';
        if (req.error) {
          statusText = 'ERR';
        } else if (req.grpcStatus) {
          var info = GrpcAI.GRPC_STATUS_CODES[req.grpcStatus.code];
          statusText = info ? info.name : ('c' + req.grpcStatus.code);
        } else if (req.responseStatus >= 400) {
          statusText = String(req.responseStatus);
        }

        return (
          '<div class="request-item ' + statusClass + (isSelected ? ' selected' : '') + '" data-id="' + req.id + '">' +
            '<div class="request-item-header">' +
              '<span class="request-method">' + (req.method || 'POST') + '</span>' +
              '<span class="request-name">' + escapeHtml(req.serviceName + '/' + req.methodName) + '</span>' +
              '<span class="request-status ' + statusBadgeClass + '">' + statusText + '</span>' +
            '</div>' +
            '<div class="request-url">' + escapeHtml(req.url) + '</div>' +
            '<div class="request-meta">' +
              '<span>' + (req.duration != null ? req.duration.toFixed(0) : '?') + 'ms</span>' +
              '<span>' + ((req.responseFrames || []).length) + ' frames</span>' +
            '</div>' +
          '</div>'
        );
      }).join('');

      requestList.innerHTML = html;

      requestList.querySelectorAll('.request-item').forEach(function (el) {
        el.addEventListener('click', function () {
          var id = el.dataset.id;
          selectedRequestId = id;
          var req = requests.find(function (r) { return r.id === id; });
          renderRequestList();
          renderDetail(req);
          renderAiInsights(req);
        });
      });
    } catch (e) {
      console.error('[gRPC DevTools] renderRequestList error:', e);
      if (requestList) {
        requestList.innerHTML = '<div class="empty-state"><p>Render error: ' + escapeHtml(e.message) + '</p></div>';
      }
    }
  }

  function renderDetail(req) {
    if (!detailPanel) return;
    try {
      if (!req) {
        detailPanel.innerHTML = '<div class="empty-state"><p>Select a request to view details</p></div>';
        return;
      }

      var reqDecoded = (req.requestFrames && req.requestFrames.length > 0)
        ? decodeBase64Proto(req.requestFrames[0].data)
        : null;
      var resDecoded = (req.responseFrames && req.responseFrames.length > 0)
        ? decodeBase64Proto(req.responseFrames[0].data)
        : null;

      detailPanel.innerHTML =
        '<div class="detail-header">' +
          '<div class="detail-title">' + escapeHtml(req.serviceName) + ' / ' + escapeHtml(req.methodName) + '</div>' +
          '<div class="detail-url">' + escapeHtml(req.url) + '</div>' +
        '</div>' +
        '<div class="detail-tabs">' +
          '<div class="detail-tab' + (activeTab === 'request' ? ' active' : '') + '" data-tab="request">Request</div>' +
          '<div class="detail-tab' + (activeTab === 'response' ? ' active' : '') + '" data-tab="response">Response</div>' +
          '<div class="detail-tab' + (activeTab === 'headers' ? ' active' : '') + '" data-tab="headers">Headers</div>' +
          '<div class="detail-tab' + (activeTab === 'raw' ? ' active' : '') + '" data-tab="raw">Raw</div>' +
        '</div>' +
        '<div class="detail-content" id="detailContent"></div>';

      detailPanel.querySelectorAll('.detail-tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
          activeTab = tab.dataset.tab;
          detailPanel.querySelectorAll('.detail-tab').forEach(function (t) { t.classList.remove('active'); });
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
    var content = document.getElementById('detailContent');
    if (!content) return;

    try {
      if (activeTab === 'request') {
        content.innerHTML =
          '<div class="section-title">Decoded request payload</div>' +
          (reqDecoded ? renderJson(reqDecoded) : '<p class="ai-placeholder">No request body</p>') +
          ((req.requestFrames || []).length > 1 ? '<div class="section-title">Additional frames (' + ((req.requestFrames || []).length - 1) + ' more)</div>' : '');
      } else if (activeTab === 'response') {
        var grpcInfo = '';
        if (req.grpcStatus) {
          var isOk = req.grpcStatus.code === 0;
          grpcInfo = '<div class="ai-insight ' + (isOk ? 'success' : 'error') + '">' +
            '<div class="ai-insight-title">gRPC Status: ' + (GrpcAI.GRPC_STATUS_CODES[req.grpcStatus.code] ? GrpcAI.GRPC_STATUS_CODES[req.grpcStatus.code].name : 'Unknown') + ' (code ' + req.grpcStatus.code + ')</div>' +
            (req.grpcStatus.message ? '<div>' + escapeHtml(req.grpcStatus.message) + '</div>' : '') +
          '</div>';
        }
        content.innerHTML =
          grpcInfo +
          '<div class="section-title">Decoded response payload</div>' +
          (resDecoded ? renderJson(resDecoded) : '<p class="ai-placeholder">No response body</p>') +
          ((req.responseFrames || []).length > 1 ? '<div class="section-title">Additional frames (' + ((req.responseFrames || []).length - 1) + ' more)</div>' : '');
      } else if (activeTab === 'headers') {
        var reqHeaders = '';
        var reqH = req.requestHeaders || {};
        var keys = Object.keys(reqH);
        for (var i = 0; i < keys.length; i++) {
          reqHeaders += '<tr><td>' + escapeHtml(keys[i]) + '</td><td>' + escapeHtml(String(reqH[keys[i]])) + '</td></tr>';
        }
        var resHeaders = '';
        var resH = req.responseHeaders || {};
        keys = Object.keys(resH);
        for (i = 0; i < keys.length; i++) {
          resHeaders += '<tr><td>' + escapeHtml(keys[i]) + '</td><td>' + escapeHtml(String(resH[keys[i]])) + '</td></tr>';
        }
        content.innerHTML =
          '<div class="section-title">Request headers</div>' +
          '<table class="headers-table">' + (reqHeaders || '<tr><td colspan="2">No headers</td></tr>') + '</table>' +
          '<div class="section-title">Response headers</div>' +
          '<table class="headers-table">' + (resHeaders || '<tr><td colspan="2">No headers</td></tr>') + '</table>';
      } else if (activeTab === 'raw') {
        var reqFramesHtml = '';
        (req.requestFrames || []).forEach(function (f, i) {
          reqFramesHtml +=
            '<div class="frame-item">' +
              '<div class="frame-label">Frame ' + (i + 1) + (f.compressed ? ' (compressed)' : '') + (f.truncated ? ' (truncated)' : '') + '</div>' +
              '<div class="raw-hex">' + escapeHtml(f.data.substring(0, 500)) + (f.data.length > 500 ? '...' : '') + '</div>' +
            '</div>';
        });
        var resFramesHtml = '';
        (req.responseFrames || []).forEach(function (f, i) {
          resFramesHtml +=
            '<div class="frame-item">' +
              '<div class="frame-label">Frame ' + (i + 1) + (f.compressed ? ' (compressed)' : '') + (f.truncated ? ' (truncated)' : '') + '</div>' +
              '<div class="raw-hex">' + escapeHtml(f.data.substring(0, 500)) + (f.data.length > 500 ? '...' : '') + '</div>' +
            '</div>';
        });
        content.innerHTML =
          '<div class="section-title">Request frames (base64)</div>' +
          (reqFramesHtml || '<p class="ai-placeholder">No request frames</p>') +
          '<div class="section-title">Response frames (base64)</div>' +
          (resFramesHtml || '<p class="ai-placeholder">No response frames</p>');
      }
    } catch (e) {
      console.error('[gRPC DevTools] renderTabContent error:', e);
    }
  }

  function renderJson(obj) {
    try {
      var jsonStr = JSON.stringify(obj, null, 2);
      var safe = jsonStr
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      safe = safe.replace(/("(?:\\[^"]|[^"])*?")\s*:/g, '<span class="json-key">$1</span>:')
        .replace(/("(?:\\[^"]|[^"])*?")/g, '<span class="json-string">$1</span>')
        .replace(/\b(true|false)\b/g, '<span class="json-bool">$1</span>')
        .replace(/\bnull\b/g, '<span class="json-null">null</span>')
        .replace(/-?\b\d+(\.\d+)?([eE][+-]?\d+)?\b/g, '<span class="json-number">$&</span>');
      return '<div class="json-viewer">' + safe + '</div>';
    } catch (e) {
      return '<div class="ai-placeholder">JSON encode error: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderAiInsights(req) {
    if (!aiContent) return;
    try {
      if (!req) {
        aiContent.innerHTML = '<p class="ai-placeholder">AI-powered debugging insights will appear here. Select a request to get started.</p>';
        if (aiActions) aiActions.style.display = 'none';
        return;
      }
      var insights = GrpcAI.diagnoseError(req);
      aiContent.innerHTML = insights.map(function (insight) {
        return '<div class="ai-insight ' + insight.level + '">' +
          '<div class="ai-insight-title">' + escapeHtml(insight.title) + '</div>' +
          '<div>' + escapeHtml(insight.detail) + '</div>' +
        '</div>';
      }).join('');
      if (aiActions) aiActions.style.display = 'flex';
      if (aiActions) aiActions.querySelectorAll('button').forEach(function (btn) {
        btn.onclick = function () { handleAiAction(btn.dataset.action, req); };
      });
    } catch (e) {
      console.error('[gRPC DevTools] renderAiInsights error:', e);
    }
  }

  function handleAiAction(action, req) {
    if (!aiContent) return;
    if (!GrpcAI.isConfigured()) {
      aiContent.innerHTML = '<div class="ai-insight warning"><div class="ai-insight-title">AI not configured</div><div>Click Settings to configure your AI API key.</div></div>';
      return;
    }
    aiContent.innerHTML = '<div class="ai-loading">Analyzing...</div>';
    try {
      if (action === 'diagnose') {
        GrpcAI.aiDiagnose(req).then(function (insights) {
          aiContent.innerHTML = insights.map(function (insight) {
            return '<div class="ai-insight ' + insight.level + '">' +
              '<div class="ai-insight-title">' + escapeHtml(insight.title) + '</div>' +
              '<div>' + escapeHtml(insight.detail) + '</div>' +
            '</div>';
          }).join('');
        }).catch(function (e) {
          aiContent.innerHTML = '<div class="ai-insight error"><div>AI Error: ' + escapeHtml(e.message) + '</div></div>';
        });
      }
    } catch (e) {
      aiContent.innerHTML = '<div class="ai-insight error"><div>AI Error: ' + escapeHtml(e.message) + '</div></div>';
    }
  }

  function updateCount() {
    if (requestCount) requestCount.textContent = String(requests.length);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Init on DOM ready ────────────────────────────────────────
  function init() {
    // Grab DOM refs
    requestList = document.getElementById('requestList');
    detailPanel = document.getElementById('detailPanel');
    searchInput = document.getElementById('searchInput');
    clearBtn = document.getElementById('clearBtn');
    exportBtn = document.getElementById('exportBtn');
    aiSearchBtn = document.getElementById('aiSearchBtn');
    recordToggle = document.getElementById('recordToggle');
    requestCount = document.getElementById('requestCount');
    aiContent = document.getElementById('aiContent');
    aiActions = document.getElementById('aiActions');
    aiConfigBtn = document.getElementById('aiConfigBtn');
    aiModal = document.getElementById('aiModal');
    aiModalCancel = document.getElementById('aiModalCancel');
    aiModalSave = document.getElementById('aiModalSave');
    statusBar = document.getElementById('statusBar');

    console.log('[gRPC DevTools] DOM ready, elements found:',
      'requestList=' + !!requestList,
      'detailPanel=' + !!detailPanel,
      'statusBar=' + !!statusBar
    );

    // Tab ID
    tabId = chrome.devtools.inspectedWindow.tabId;
    console.log('[gRPC DevTools] Panel init, tabId:', tabId);

    if (!tabId) {
      console.error('[gRPC DevTools] No tabId! inspectedWindow:', chrome.devtools.inspectedWindow);
      setStatus('error', 'No tabId — cannot monitor');
      return;
    }

    // AI config
    GrpcAI.loadConfig();

    // Connect to background
    connectPort();

    // ─── Toolbar events ──────────────────────────────────────
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'clear-requests', tabId: tabId });
        requests = [];
        renderRequestList();
        updateCount();
        renderDetail(null);
        renderAiInsights(null);
      });
    }

    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        var json = JSON.stringify(requests, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'grpc-requests-' + Date.now() + '.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    if (recordToggle) {
      recordToggle.addEventListener('change', function (e) {
        recording = e.target.checked;
      });
    }

    if (aiSearchBtn) {
      aiSearchBtn.addEventListener('click', function () {
        if (!searchInput) return;
        var query = searchInput.value.trim();
        if (!query) return;
        filterRequests(query);
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', function () {
        var query = searchInput.value.trim().toLowerCase();
        requestList.querySelectorAll('.request-item').forEach(function (el) {
          var text = el.textContent.toLowerCase();
          el.style.display = text.indexOf(query) >= 0 ? '' : 'none';
        });
      });
    }

    // ─── AI config modal ─────────────────────────────────────
    if (aiConfigBtn && aiModal) {
      aiConfigBtn.addEventListener('click', function () {
        var config = GrpcAI.getConfig();
        var providerEl = document.getElementById('aiProvider');
        var apiKeyEl = document.getElementById('aiApiKey');
        var modelEl = document.getElementById('aiModel');
        var baseUrlEl = document.getElementById('aiBaseUrl');
        if (providerEl) providerEl.value = config.provider || 'openai';
        if (apiKeyEl) apiKeyEl.value = config.apiKey || '';
        if (modelEl) modelEl.value = config.model || 'gpt-4o-mini';
        if (baseUrlEl) baseUrlEl.value = config.baseUrl || '';
        aiModal.style.display = 'flex';
      });
    }

    if (aiModalCancel && aiModal) {
      aiModalCancel.addEventListener('click', function () {
        aiModal.style.display = 'none';
      });
    }

    if (aiModalSave && aiModal) {
      aiModalSave.addEventListener('click', function () {
        GrpcAI.saveConfig({
          provider: document.getElementById('aiProvider').value,
          apiKey: document.getElementById('aiApiKey').value,
          model: document.getElementById('aiModel').value,
          baseUrl: document.getElementById('aiBaseUrl').value,
        });
        aiModal.style.display = 'none';
      });
    }

    console.log('[gRPC DevTools] Panel initialized OK');
  }

  function filterRequests(query) {
    if (!requestList) return;
    requestList.querySelectorAll('.request-item').forEach(function (el) {
      var text = el.textContent.toLowerCase();
      el.style.display = text.indexOf(query) >= 0 ? '' : 'none';
    });
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Global error handlers
  window.addEventListener('error', function (e) {
    console.error('[gRPC DevTools] PANEL ERROR:', e.message, 'at', e.filename, ':', e.lineno);
  });

  window.addEventListener('unhandledrejection', function (e) {
    console.error('[gRPC DevTools] PANEL REJECTION:', e.reason);
  });
})();
