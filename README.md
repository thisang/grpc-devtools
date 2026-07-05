# gRPC DevTools Monitor

A Chrome DevTools extension for monitoring gRPC / gRPC-Web traffic directly in the browser DevTools panel. Solves the problem of gRPC request and response bodies showing as garbled binary in the standard Network panel.

## Features

### Core
- **gRPC / gRPC-Web traffic capture** — Automatically hooks `fetch()` and `XMLHttpRequest` to intercept all gRPC traffic
- **Binary protobuf decoding** — Schema-less protobuf wire format decoder that converts binary payloads to readable JSON
- **DevTools panel** — Custom "gRPC" tab in Chrome DevTools with request list, detail view, and AI sidebar
- **gRPC frame parsing** — Correctly parses gRPC framing (compressed flag + length + payload)
- **grpc-web-text support** — Automatically decodes base64-encoded grpc-web-text payloads
- **Request/response inspection** — View decoded payloads, raw headers, and base64 raw data
- **Export** — Export captured requests as JSON for sharing or offline analysis

### AI-Powered (optional)
- **Error diagnosis** — Built-in gRPC status code knowledge + AI-powered deep analysis
- **Request summarization** — AI generates a natural language summary of what was requested and returned
- **Replay code generation** — Generate curl/grpcurl/Node.js/Python code to replay a captured request
- **Natural language search** — Filter requests using natural language queries ("find all failed requests")
- **Proto schema inference** — AI infers a `.proto` schema from decoded field data

## Installation

### From source (developer mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/thisang/grpc-devtools.git
   ```

2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `grpc-devtools` directory
5. Open DevTools (F12) on any page making gRPC calls — you'll see a new **gRPC** tab

## Usage

1. Open a web page that makes gRPC / gRPC-Web calls
2. Open DevTools (F12 or Cmd+Option+I)
3. Switch to the **gRPC** tab
4. Interact with the page — gRPC requests will appear in real-time
5. Click any request to see decoded request/response payloads
6. Use the AI sidebar for intelligent debugging insights

### AI Configuration

To enable AI-powered features:

1. Click the **Settings** button in the AI sidebar
2. Choose your provider (OpenAI, Anthropic, or custom OpenAI-compatible endpoint)
3. Enter your API key
4. Select a model (default: `gpt-4o-mini`)
5. Save — the key is stored locally in `chrome.storage` and never sent anywhere except the provider

Without AI configured, the extension still provides:
- Full protobuf decoding
- Built-in error code diagnosis (based on gRPC status code reference)
- Quick request summaries
- All core inspection features

## How It Works

```
Page gRPC traffic (binary protobuf)
        │
        ▼
  Content Script (MAIN world)
  Hooks fetch() + XHR
  Parses gRPC frames
        │
        ▼
  Background Service Worker
  Stores requests per tab
        │
        ▼
  DevTools Panel
  ┌─────────┬──────────┬──────────┐
  │ Request │ Detail   │ AI       │
  │ List    │ Viewer   │ Sidebar  │
  └─────────┴──────────┴──────────┘
```

### Protobuf Decoding

The decoder works without a `.proto` schema by parsing the protobuf wire format directly:

- **Varint (wire type 0)** — int32, int64, uint32, uint64, bool, enum
- **64-bit (wire type 1)** — fixed64, sfixed64, double
- **Length-delimited (wire type 2)** — string, bytes, nested messages, packed repeated
- **32-bit (wire type 5)** — fixed32, sfixed32, float

For length-delimited fields, the decoder heuristically tries:
1. Nested protobuf message (validates field tags)
2. UTF-8 string (validates encoding + control char ratio)
3. Raw bytes (hex display)

## Project Structure

```
grpc-devtools/
├── manifest.json       # Extension manifest (V3)
├── background.js        # Service worker - request storage & messaging
├── content.js           # Content script - fetch/XHR hooks
├── decoder.js           # Protobuf wire format decoder
├── ai.js                # AI assistant module
├── panel.html           # DevTools panel HTML
├── panel.css            # Panel styles
├── panel.js             # Panel logic
├── devtools.html        # DevTools registration page
├── devtools.js          # Panel creation script
└── icons/               # Extension icons
```

## Limitations

- Currently supports gRPC-Web (browser-based gRPC). Native gRPC over HTTP/2 with TLS requires the `chrome.debugger` API (planned).
- Schema-less decoding assigns field numbers as keys (`field1`, `field2`, etc.). Use the AI schema inference feature to get meaningful field names.
- Compression (gzip) in gRPC frames is detected but not yet decompressed.

## License

MIT
