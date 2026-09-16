# hookr

> A lightweight HTTP request catcher with a live UI and one-click request replay.

hookr runs a local HTTP server that captures incoming requests, logs the full request details, displays them in a browser UI, and lets you forward captured traffic to another destination. It is built for debugging webhooks, callbacks, integrations, local services, and any workflow where you need to inspect an HTTP request before replaying it somewhere else.

```text
client or webhook provider
        |
        v
  http://localhost:3000/anything
        |
        v
      hookr
   capture -> inspect -> forward
```

## ✨ Highlights

| Area | What hookr gives you |
| --- | --- |
| Capture | Records method, URL, path, query, headers, remote address, timestamp, body, size, and request ID. |
| Live UI | Shows new requests instantly through Server-Sent Events. |
| Inspection | Displays headers, body text, formatted JSON, binary bodies as base64, and request metadata. |
| Replay | Forwards a captured request to any HTTP or HTTPS target. |
| Controls | Clear all captures, copy body content, copy pretty JSON, and copy a generated `curl` command. |
| Storage | Keeps the newest 500 requests in memory. |

## 🚀 Quick Start

```sh
npm install
npm start
```

Then open:

```text
http://localhost:3000/
```

Send a request to any capture path:

```sh
curl -X POST http://localhost:3000/webhooks/payment \
  -H "content-type: application/json" \
  -d '{"event":"payment.created","id":"evt_123"}'
```

The request will appear immediately in the UI.

## 📦 Requirements

- Node.js 18 or newer
- npm

hookr only depends on Express.

## 🖥️ Running The Server

Start on the default port, `3000`:

```sh
npm start
```

Start on a specific port:

```sh
node server.js 8080
```

Or use `PORT`:

```sh
PORT=8080 npm start
```

Run in watch mode during development:

```sh
npm run dev
```

## 🎣 How Capture Works

hookr serves the UI at `/` and reserves `/__` for its internal API. Every other non-asset path is treated as a capture endpoint.

Good capture paths:

```text
/webhooks/payment
/callback/github
/api/test?debug=true
/anything/you/want
```

Avoid:

```text
/
/app.js
/style.css
/__/*
```

Each captured request receives a generated ID and an acknowledgement response:

```json
{
  "ok": true,
  "id": "generated-request-id",
  "capturedAt": "2026-01-01T00:00:00.000Z"
}
```

The browser UI then shows the request in the left-hand list. Selecting a request opens the detail view with:

- Request metadata
- Headers
- Body preview
- Forwarding controls
- Forwarding history
- Copy actions

## 🔁 Forwarding And Replay

Select a captured request, enter a target URL, optionally choose a method override, and press `Forward`.

When hookr forwards a request, it sends:

- The original body
- The original method, unless overridden
- The original headers, except hop-by-hop transport headers
- A `host` header matching the target host

The forwarding layer skips these transport headers:

```text
host
content-length
connection
transfer-encoding
```

If the target URL does not include a meaningful path, hookr preserves the captured path and query string.

Example:

```text
Captured:  /webhooks/payment?debug=true
Target:    https://example.com
Forwarded: https://example.com/webhooks/payment?debug=true
```

If the target URL includes a path, hookr uses that path:

```text
Captured:  /webhooks/payment?debug=true
Target:    https://example.com/custom-target
Forwarded: https://example.com/custom-target
```

Forwarding results are stored on the captured request and displayed in the UI with status, response headers, elapsed time, response body preview, or error details.

## 🧭 UI Features

| Feature | Description |
| --- | --- |
| Request list | Newest requests appear first with method, path, time, body size, and remote address. |
| Live status | The header shows whether the UI is connected to the event stream. |
| Detail panel | Shows request metadata, headers, and body content. |
| Body formatting | Textual bodies are shown as text. JSON bodies are pretty-printed when possible. |
| Binary handling | Non-text bodies are stored and displayed as base64. |
| Copy actions | Copy raw body, pretty body, or a generated `curl` command. |
| Forwarding | Replay the selected request to another URL. |
| Clear all | Remove all captured requests from memory. |

## 🛠️ Internal API

hookr's browser UI talks to the server through the reserved `/__` namespace.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/__/requests` | Returns captured requests, newest first. |
| `GET` | `/__/events` | Opens the Server-Sent Events stream. |
| `POST` | `/__/clear` | Clears all captured requests. |
| `POST` | `/__/forward` | Forwards a captured request to a target URL. |

### 📤 Forward Request Body

```json
{
  "id": "captured-request-id",
  "target": "https://example.com",
  "overrideMethod": "POST"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | Yes | ID of the captured request to replay. |
| `target` | Yes | Destination HTTP or HTTPS URL. |
| `overrideMethod` | No | Uses the captured method when omitted. |
| `preserveHost` | No | Supported by the forwarding layer. |
| `extraHeaders` | No | Supported by the forwarding layer. |

The current UI sends `id`, `target`, and `overrideMethod`.

## 🗂️ Project Structure

```text
.
|-- server.js              # CLI entrypoint; starts the HTTP server
|-- src/
|   |-- app.js             # Express app setup and middleware order
|   |-- forwarder.js       # Captured request replay logic
|   |-- sse.js             # Server-Sent Events client broker
|   |-- store.js           # In-memory request store
|   `-- routes/
|       |-- api.js         # Internal /__ API routes
|       `-- capture.js     # Catch-all request capture route
`-- public/
    |-- index.html         # Browser UI shell
    |-- app.js             # UI state, rendering, SSE, and actions
    `-- style.css          # UI styles
```

## ⚙️ Runtime Notes

| Limit or behavior | Value |
| --- | --- |
| Request storage | In memory only |
| Stored request count | Newest 500 captures |
| Captured body limit | 25 MB |
| Internal API JSON limit | 1 MB |
| Forwarded response body preview | 200,000 UTF-8 characters |
| Authentication | Not included |
| Persistence | Not included |
| TLS termination | Not included |

Because hookr captures and replays raw HTTP traffic, run it in trusted local or development environments.

## 📜 Scripts

| Command | Description |
| --- | --- |
| `npm start` | Starts hookr with `node server.js`. |
| `npm run dev` | Starts hookr with `node --watch server.js`. |

## 🧪 Example Workflow

1. Start hookr with `npm start`.
2. Open `http://localhost:3000/`.
3. Configure a webhook provider, local app, or HTTP client to send requests to `http://localhost:3000/<your-path>`.
4. Inspect each captured request in the UI.
5. Copy the generated `curl` command if you want to reproduce the request manually.
6. Enter a target URL and forward the captured request when you are ready to replay it.
