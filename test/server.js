/**
 * Test server that simulates a gRPC-Web endpoint.
 * Serves a test HTML page and a fake gRPC-Web response.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = 9876;

// Build a fake gRPC-Web response frame:
// 1 byte compressed flag (0) + 4 byte length (big-endian) + protobuf payload
function buildGrpcWebResponse() {
  // Simple protobuf message: field 1 (string) = "Hello"
  // field 1, wire type 2 (length-delimited): tag = 0x0a
  // length = 5, value = "Hello"
  const payload = Buffer.from([0x0a, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0); // not compressed
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// For grpc-web-text, the frame is base64-encoded
function buildGrpcWebTextResponse() {
  const binary = buildGrpcWebResponse();
  return Buffer.from(binary.toString('base64'));
}

// Build a fake gRPC-Web request body (same format)
function buildGrpcWebRequest() {
  // field 1 (string) = "World"
  const payload = Buffer.from([0x0a, 0x05, 0x57, 0x6f, 0x72, 0x6c, 0x64]);
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-grpc-web, x-user-agent');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<body>
<h1>gRPC-Web Test Page</h1>
<button id="btn" onclick="makeRequest()">Send gRPC-Web Request</button>
<pre id="output"></pre>
<script>
function makeRequest() {
  var body = ${JSON.stringify(buildGrpcWebRequest().toString('base64'))};
  var binary = atob(body);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/grpc/helloworld.Greeter/SayHello');
  xhr.setRequestHeader('Content-Type', 'application/grpc-web-text');
  xhr.setRequestHeader('X-Grpc-Web', '1');
  xhr.responseType = 'arraybuffer';
  xhr.onload = function() {
    document.getElementById('output').textContent = 'Response received: ' + xhr.status;
  };
  xhr.send(bytes.buffer);
}
</script>
</body>
</html>`);
    return;
  }

  if (req.url === '/grpc/helloworld.Greeter/SayHello') {
    const grpcBody = buildGrpcWebTextResponse();
    res.writeHead(200, {
      'Content-Type': 'application/grpc-web-text',
      'grpc-status': '0',
      'grpc-message': '',
    });
    res.end(grpcBody);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('Test server running on http://localhost:' + PORT);
});
