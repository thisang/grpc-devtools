/**
 * Test: verify gRPC DevTools extension captures requests.
 *
 * 1. Launches Chrome with extension loaded
 * 2. Opens test page, clicks button to send gRPC-Web request
 * 3. Inspects background service worker logs via CDP
 * 4. Reports whether the request reached background and was stored
 */

const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');

const EXT_PATH = path.join(__dirname, '..');
const PORT = 17777;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        // Page sends a gRPC-Web request when button is clicked
        res.end(`<!DOCTYPE html>
<html>
<body>
<h2>gRPC-Web Test</h2>
<button id="btn">Send gRPC Request</button>
<pre id="out"></pre>
<script>
function makeReq() {
  // gRPC-Web binary frame: 1 byte flag + 4 byte length + protobuf payload
  var payload = new Uint8Array([0x0a, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  var frame = new Uint8Array(5);
  frame[0] = 0;
  // length in big-endian: bytes 1-4
  frame[1] = 0; frame[2] = 0; frame[3] = 0; frame[4] = payload.length;
  var buf = new Uint8Array(5 + payload.length);
  buf.set(frame);
  buf.set(payload, 5);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/grpc/helloworld.Greeter/SayHello');
  xhr.setRequestHeader('Content-Type', 'application/grpc-web+proto');
  xhr.responseType = 'arraybuffer';
  xhr.onload = function() {
    document.getElementById('out').textContent =
      'Status: ' + xhr.status + ' CT: ' + (xhr.getResponseHeader('content-type') || '');
  };
  xhr.onerror = function() {
    document.getElementById('out').textContent = 'Error';
  };
  xhr.send(buf.buffer);
}
document.getElementById('btn').addEventListener('click', makeReq);
// Auto-send on load
setTimeout(makeReq, 500);
</script>
</body>
</html>`);
        return;
      }

      if (req.url.includes('/grpc/')) {
        // Fake gRPC-Web response
        var payload = Buffer.from([0x0a, 0x05, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
        var frame = Buffer.alloc(5);
        frame[0] = 0;
        frame.writeUInt32BE(payload.length, 1);
        var body = Buffer.concat([frame, payload]);
        res.writeHead(200, {
          'Content-Type': 'application/grpc-web+proto',
          'grpc-status': '0',
        });
        res.end(body);
        return;
      }

      res.writeHead(404);
      res.end();
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

async function main() {
  const server = await startServer();
  console.log(`[test] Server: http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--load-extension=${EXT_PATH}`,
      `--disable-extensions-except=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  let dbgUrl = null;
  const versions = await browser.version();
  console.log('[test] Browser:', versions);

  // Get debugger URL to connect to background SW
  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.goto(`http://localhost:${PORT}/`);
    await sleep(3000);

    // Collect page console logs
    const pageLogs = [];
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('gRPC') || t.includes('DevTools') || t.includes('grpc')) {
        pageLogs.push(`[PAGE] ${t}`);
      }
    });

    await sleep(3000);
    console.log('[test] Page logs:');
    pageLogs.forEach(l => console.log(l));

    // Find background service worker
    const targets = await browser.targets();
    const bgTarget = targets.find(t =>
      t.type() === 'service_worker' && t.url().includes('background.js')
    );

    if (!bgTarget) {
      console.log('\n[test] ERROR: background service worker not found!');
      console.log('[test] All targets:');
      targets.forEach(t => console.log(`  ${t.type()}: ${t.url()}`));
      await browser.close();
      server.close();
      process.exit(1);
    }

    console.log(`\n[test] Found background SW: ${bgTarget.url()}`);

    // Get SW console logs
    const client = await bgTarget.createCDPSession();
    await client.send('Runtime.enable');
    await client.send('Console.enable');

    const bgLogs = [];
    client.on('Runtime.consoleAPICalled', params => {
      const text = params.args.map(a => {
        if (a.value !== undefined) return a.value;
        if (a.description) return a.description;
        return '';
      }).join(' ');
      bgLogs.push(text);
    });

    // Reload to trigger another request (SW logs are being captured now)
    console.log('[test] Reloading to capture SW logs...');
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(4000);

    console.log('\n[test] === Background SW Console Logs ===');
    if (bgLogs.length === 0) {
      console.log('  (no logs captured - SW may not have started, or logging failed)');
    }
    bgLogs.forEach(l => console.log(`  [BG] ${l}`));

    // Now simulate a panel connecting to the background via a fake port
    // We use the same CDP session to evaluate code in the background SW
    console.log('\n[test] Simulating panel connection via CDP...');

    // Evaluate in SW context: connect a port and listen
    const panelTabId = 157967538; // from the test logs
    const connectResult = await client.send('Runtime.evaluate', {
      expression: `
        (function() {
          try {
            var port = chrome.runtime.connect({ name: 'grpc-panel-${panelTabId}' });
            var messages = [];
            port.onMessage.addListener(function(msg) {
              messages.push(JSON.stringify(msg));
            });
            port.onDisconnect.addListener(function() {
              messages.push('DISCONNECTED');
            });
            // Store for later inspection
            globalThis.__testPort = port;
            globalThis.__testMessages = messages;
            return 'connected';
          } catch(e) {
            return 'error: ' + e.message;
          }
        })()
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log('[test] Port connect result:', connectResult.result?.value);

    await sleep(2000);

    // Check what messages the fake panel received
    const msgResult = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify(globalThis.__testMessages || [])',
      returnByValue: true,
    });
    console.log('[test] Fake panel received messages:', msgResult.result?.value);

    // Now trigger another request from the page
    console.log('[test] Triggering another request...');
    await page.click('#btn');
    await sleep(3000);

    const msgResult2 = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify(globalThis.__testMessages || [])',
      returnByValue: true,
    });
    console.log('[test] Fake panel received after new request:', msgResult2.result?.value);

    // Summary
    console.log('\n[test] === RESULT ===');
    const gotOnMessage = bgLogs.some(l => l.includes('onMessage') || l.includes('BG:'));
    const gotStored = bgLogs.some(l => l.includes('stored'));
    const fakePanelGotInit = (msgResult2.result?.value || '').includes('init');
    const fakePanelGotNew = (msgResult2.result?.value || '').includes('new-request');

    console.log('  Background received message:', gotOnMessage);
    console.log('  Background stored request:', gotStored);
    console.log('  Fake panel received init:', fakePanelGotInit);
    console.log('  Fake panel received new-request:', fakePanelGotNew);

    if (fakePanelGotInit && fakePanelGotNew) {
      console.log('\n  SUCCESS: Full chain works! Background ↔ panel push works.');
      console.log('  The issue must be in the real panel.js code.');
    } else if (fakePanelGotInit && !fakePanelGotNew) {
      console.log('\n  PARTIAL: init works but new-request push fails.');
      console.log('  Check if background port.postMessage for new-request is working.');
    } else {
      console.log('\n  FAIL: Panel ↔ background connection not working.');
    }

  } finally {
    await sleep(2000);
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
