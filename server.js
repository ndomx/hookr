#!/usr/bin/env node
// hookr — a tiny HTTP request capture & forwarder
// Usage: node server.js [port]   (default 3000)

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const MAX_REQUESTS = 500;

const requests = []; // newest first
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { // 25MB cap
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isTextual(headers, body) {
  const ct = (headers['content-type'] || '').toLowerCase();
  if (/json|text|xml|form-urlencoded|javascript|html|csv/.test(ct)) return true;
  if (body.length === 0) return true;
  // heuristic: no null bytes in first 1KB
  const sample = body.slice(0, 1024);
  for (const b of sample) if (b === 0) return false;
  return true;
}

function storeRequest(rec) {
  requests.unshift(rec);
  if (requests.length > MAX_REQUESTS) requests.length = MAX_REQUESTS;
  broadcast('request', rec);
}

// Internal routes start with /__
const INTERNAL = new Set(['/', '/__events', '/__requests', '/__forward', '/__clear']);

async function handleInternal(req, res, urlObj) {
  if (urlObj.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
    return;
  }

  if (urlObj.pathname === '/__events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(`event: hello\ndata: {}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  if (urlObj.pathname === '/__requests' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(requests));
    return;
  }

  if (urlObj.pathname === '/__clear' && req.method === 'POST') {
    requests.length = 0;
    broadcast('clear', {});
    res.writeHead(204).end();
    return;
  }

  if (urlObj.pathname === '/__forward' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
    const { id, target, preserveHost = false, overrideMethod, extraHeaders } = payload;
    const rec = requests.find((r) => r.id === id);
    if (!rec) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request not found' }));
      return;
    }
    let targetUrl;
    try { targetUrl = new URL(target); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid target url' }));
      return;
    }
    // Append the captured path/query if target has no path
    if (targetUrl.pathname === '/' || targetUrl.pathname === '') {
      try {
        const capturedUrl = new URL('http://x' + rec.url);
        targetUrl.pathname = capturedUrl.pathname;
        targetUrl.search = capturedUrl.search;
      } catch {}
    }

    const lib = targetUrl.protocol === 'https:' ? https : http;
    const headers = { ...rec.headers };
    delete headers['host'];
    delete headers['content-length'];
    if (!preserveHost) headers['host'] = targetUrl.host;
    if (extraHeaders && typeof extraHeaders === 'object') Object.assign(headers, extraHeaders);

    const body = Buffer.from(rec.bodyBase64, 'base64');
    const startedAt = Date.now();
    const fwReq = lib.request(
      {
        method: overrideMethod || rec.method,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        headers,
      },
      (fwRes) => {
        const chunks = [];
        fwRes.on('data', (c) => chunks.push(c));
        fwRes.on('end', () => {
          const respBody = Buffer.concat(chunks);
          const result = {
            status: fwRes.statusCode,
            statusText: fwRes.statusMessage,
            headers: fwRes.headers,
            body: respBody.toString('utf8').slice(0, 200_000),
            elapsedMs: Date.now() - startedAt,
            target: targetUrl.toString(),
            at: new Date().toISOString(),
          };
          rec.forwards = rec.forwards || [];
          rec.forwards.unshift(result);
          broadcast('forward', { id: rec.id, result });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        });
      }
    );
    fwReq.on('error', (err) => {
      const result = { error: err.message, target: targetUrl.toString(), at: new Date().toISOString() };
      rec.forwards = rec.forwards || [];
      rec.forwards.unshift(result);
      broadcast('forward', { id: rec.id, result });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    if (body.length) fwReq.write(body);
    fwReq.end();
    return;
  }

  res.writeHead(404).end();
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (INTERNAL.has(urlObj.pathname)) {
    try { await handleInternal(req, res, urlObj); }
    catch (e) { res.writeHead(500).end(e.message); }
    return;
  }

  // Capture everything else
  let body;
  try { body = await readBody(req); }
  catch (e) {
    res.writeHead(413).end('payload too large');
    return;
  }

  const textual = isTextual(req.headers, body);
  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    path: urlObj.pathname,
    query: Object.fromEntries(urlObj.searchParams),
    headers: req.headers,
    remoteAddr: req.socket.remoteAddress,
    bodyBase64: body.toString('base64'),
    bodyText: textual ? body.toString('utf8') : null,
    bodySize: body.length,
    textual,
    forwards: [],
  };
  storeRequest(rec);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, id: rec.id, capturedAt: rec.at }));
});

server.listen(PORT, () => {
  console.log(`hookr listening on http://localhost:${PORT}`);
  console.log(`  UI:       http://localhost:${PORT}/`);
  console.log(`  webhook:  any other path captures requests`);
});

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>hookr</title>
<style>
  :root {
    --bg: #0f1419; --panel: #161b22; --panel2: #1c232c; --border: #2a313a;
    --text: #d6deeb; --muted: #7a8694; --accent: #7ee787; --accent2: #79c0ff;
    --warn: #f0883e; --err: #ff7b72;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; }
  header { padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--panel);
           display: flex; align-items: center; gap: 12px; }
  header h1 { margin: 0; font-size: 14px; color: var(--accent); }
  header .url { color: var(--muted); }
  header .spacer { flex: 1; }
  button { background: var(--panel2); color: var(--text); border: 1px solid var(--border);
           padding: 4px 10px; border-radius: 4px; cursor: pointer; font: inherit; }
  button:hover { background: #232c37; }
  button.primary { border-color: var(--accent); color: var(--accent); }
  button.danger { border-color: var(--err); color: var(--err); }
  main { flex: 1; display: grid; grid-template-columns: 360px 1fr; min-height: 0; }
  #list { border-right: 1px solid var(--border); overflow-y: auto; background: var(--panel); }
  .item { padding: 8px 12px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .item:hover { background: var(--panel2); }
  .item.active { background: #21303e; border-left: 3px solid var(--accent); padding-left: 9px; }
  .item .top { display: flex; gap: 8px; align-items: baseline; }
  .method { font-weight: bold; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .m-GET { background: #1f3a52; color: var(--accent2); }
  .m-POST { background: #1f4d2a; color: var(--accent); }
  .m-PUT { background: #4d3a1f; color: var(--warn); }
  .m-PATCH { background: #4d3a1f; color: var(--warn); }
  .m-DELETE { background: #4d1f1f; color: var(--err); }
  .m-OPTIONS, .m-HEAD { background: #333; color: var(--muted); }
  .item .path { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .item .meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
  #detail { overflow-y: auto; padding: 16px; }
  #detail.empty { display: flex; align-items: center; justify-content: center; color: var(--muted); }
  .section { margin-bottom: 18px; }
  .section h3 { margin: 0 0 6px; font-size: 12px; color: var(--muted); text-transform: uppercase;
                letter-spacing: 1px; display: flex; gap: 8px; align-items: center; }
  pre { background: var(--panel); border: 1px solid var(--border); border-radius: 4px;
        padding: 10px; margin: 0; overflow-x: auto; max-height: 400px; overflow-y: auto;
        white-space: pre-wrap; word-break: break-all; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px;
        background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 10px; }
  .kv .k { color: var(--accent2); }
  .kv .v { color: var(--text); word-break: break-all; }
  .forward-bar { background: var(--panel); border: 1px solid var(--border); border-radius: 4px;
                 padding: 10px; display: flex; gap: 8px; align-items: center; }
  .forward-bar input { flex: 1; background: var(--bg); color: var(--text);
                       border: 1px solid var(--border); padding: 6px 8px; border-radius: 4px; font: inherit; }
  .forward-bar select { background: var(--bg); color: var(--text);
                        border: 1px solid var(--border); padding: 6px; border-radius: 4px; font: inherit; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--panel2);
           border: 1px solid var(--accent); color: var(--accent); padding: 8px 14px;
           border-radius: 4px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .forward-result { margin-top: 8px; padding: 8px; border-radius: 4px;
                    background: var(--panel2); border: 1px solid var(--border); font-size: 12px; }
  .forward-result.ok { border-color: var(--accent); }
  .forward-result.err { border-color: var(--err); }
  .empty-state { color: var(--muted); padding: 40px; text-align: center; }
  .badge { background: var(--panel2); border: 1px solid var(--border); border-radius: 10px;
           padding: 1px 8px; font-size: 11px; color: var(--muted); }
  .conn { width: 8px; height: 8px; border-radius: 50%; background: var(--err); display: inline-block; }
  .conn.on { background: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>hookr</h1>
  <span class="url">POST/GET/anything → <code id="endpoint"></code></span>
  <span class="badge"><span id="conn" class="conn"></span> <span id="conn-text">connecting</span></span>
  <span class="badge"><span id="count">0</span> captured</span>
  <span class="spacer"></span>
  <button id="clear" class="danger">Clear all</button>
</header>
<main>
  <div id="list"></div>
  <div id="detail" class="empty">Send a request to any path on this server — it'll appear here.</div>
</main>
<div id="toast" class="toast"></div>

<script>
const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const detailEl = $('#detail');
const countEl = $('#count');
let items = [];
let activeId = null;

document.getElementById('endpoint').textContent = location.origin + '/<your-path>';

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function tryPretty(text, contentType) {
  if (!text) return '';
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json') || /^[\\s]*[\\{\\[]/.test(text)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch {}
  }
  return text;
}

function renderList() {
  countEl.textContent = items.length;
  listEl.innerHTML = items.map((r) => {
    const time = new Date(r.at).toLocaleTimeString();
    return \`<div class="item \${r.id === activeId ? 'active' : ''}" data-id="\${r.id}">
      <div class="top">
        <span class="method m-\${r.method}">\${r.method}</span>
        <span class="path">\${escapeHtml(r.url)}</span>
      </div>
      <div class="meta">\${time} · \${r.bodySize}b · \${escapeHtml(r.remoteAddr || '')}</div>
    </div>\`;
  }).join('');
}

function renderDetail() {
  const r = items.find((x) => x.id === activeId);
  if (!r) {
    detailEl.className = 'empty';
    detailEl.textContent = 'Send a request to any path on this server — it\\'ll appear here.';
    return;
  }
  detailEl.className = '';
  const headerRows = Object.entries(r.headers).map(
    ([k, v]) => \`<div class="k">\${escapeHtml(k)}</div><div class="v">\${escapeHtml(v)}</div>\`
  ).join('');
  const bodyDisplay = r.textual
    ? tryPretty(r.bodyText, r.headers['content-type'])
    : \`(binary, \${r.bodySize} bytes — base64 below)\\n\\n\${r.bodyBase64}\`;

  const forwardsHtml = (r.forwards || []).map((f) => {
    if (f.error) {
      return \`<div class="forward-result err">→ \${escapeHtml(f.target)} — <strong>ERROR:</strong> \${escapeHtml(f.error)}</div>\`;
    }
    return \`<div class="forward-result \${f.status < 400 ? 'ok' : 'err'}">
      → \${escapeHtml(f.target)} — <strong>\${f.status} \${escapeHtml(f.statusText || '')}</strong> (\${f.elapsedMs}ms)
      \${f.body ? \`<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--muted)">response body</summary><pre style="max-height:200px">\${escapeHtml(f.body)}</pre></details>\` : ''}
    </div>\`;
  }).join('');

  detailEl.innerHTML = \`
    <div class="section">
      <h3>Forward <span style="text-transform:none;color:var(--muted);font-weight:normal">— replay this request to another URL</span></h3>
      <div class="forward-bar">
        <select id="fwd-method">
          <option value="">\${r.method} (keep)</option>
          <option>GET</option><option>POST</option><option>PUT</option>
          <option>PATCH</option><option>DELETE</option>
        </select>
        <input id="fwd-url" placeholder="https://example.com  (path/query preserved if target has none)" />
        <button id="fwd-send" class="primary">Forward →</button>
      </div>
      <div id="forwards">\${forwardsHtml}</div>
    </div>

    <div class="section">
      <h3>Request <button data-copy="curl">copy as curl</button></h3>
      <div class="kv">
        <div class="k">method</div><div class="v">\${r.method}</div>
        <div class="k">url</div><div class="v">\${escapeHtml(r.url)}</div>
        <div class="k">remote</div><div class="v">\${escapeHtml(r.remoteAddr || '')}</div>
        <div class="k">at</div><div class="v">\${r.at}</div>
        <div class="k">id</div><div class="v">\${r.id}</div>
      </div>
    </div>

    <div class="section">
      <h3>Headers</h3>
      <div class="kv">\${headerRows}</div>
    </div>

    <div class="section">
      <h3>Body
        <button data-copy="body">copy body</button>
        \${r.textual ? '<button data-copy="bodyPretty">copy pretty</button>' : ''}
        <span style="color:var(--muted);font-weight:normal;text-transform:none">\${r.bodySize} bytes</span>
      </h3>
      <pre id="body">\${escapeHtml(bodyDisplay)}</pre>
    </div>
  \`;

  detailEl.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.getAttribute('data-copy');
      let text = '';
      if (kind === 'body') text = r.bodyText ?? r.bodyBase64;
      else if (kind === 'bodyPretty') text = tryPretty(r.bodyText, r.headers['content-type']);
      else if (kind === 'curl') text = toCurl(r);
      navigator.clipboard.writeText(text).then(() => toast('copied'));
    });
  });

  $('#fwd-send').addEventListener('click', forwardActive);
  $('#fwd-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') forwardActive(); });
}

function toCurl(r) {
  const parts = ['curl -X ' + r.method];
  for (const [k, v] of Object.entries(r.headers)) {
    if (k === 'host' || k === 'content-length') continue;
    parts.push('  -H ' + JSON.stringify(k + ': ' + v));
  }
  if (r.bodyText) parts.push('  --data-raw ' + JSON.stringify(r.bodyText));
  parts.push('  ' + JSON.stringify('http://TARGET' + r.url));
  return parts.join(' \\\\\\n');
}

async function forwardActive() {
  const target = $('#fwd-url').value.trim();
  if (!target) { toast('enter a target URL'); return; }
  const overrideMethod = $('#fwd-method').value || undefined;
  const btn = $('#fwd-send');
  btn.disabled = true; btn.textContent = 'sending…';
  try {
    const resp = await fetch('/__forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: activeId, target, overrideMethod }),
    });
    const data = await resp.json();
    if (data.error) toast('error: ' + data.error);
    else toast(\`forwarded → \${data.status}\`);
  } catch (e) {
    toast('network error');
  } finally {
    btn.disabled = false; btn.textContent = 'Forward →';
  }
}

listEl.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item) return;
  activeId = item.dataset.id;
  renderList();
  renderDetail();
});

$('#clear').addEventListener('click', async () => {
  if (!confirm('Clear all captured requests?')) return;
  await fetch('/__clear', { method: 'POST' });
});

async function init() {
  const resp = await fetch('/__requests');
  items = await resp.json();
  renderList();
}

function connectSSE() {
  const es = new EventSource('/__events');
  es.addEventListener('hello', () => {
    $('#conn').classList.add('on');
    $('#conn-text').textContent = 'live';
  });
  es.addEventListener('request', (e) => {
    const rec = JSON.parse(e.data);
    items.unshift(rec);
    if (items.length > 500) items.length = 500;
    renderList();
  });
  es.addEventListener('forward', (e) => {
    const { id, result } = JSON.parse(e.data);
    const r = items.find((x) => x.id === id);
    if (r) { r.forwards = r.forwards || []; r.forwards.unshift(result); }
    if (id === activeId) renderDetail();
  });
  es.addEventListener('clear', () => {
    items = []; activeId = null; renderList(); renderDetail();
  });
  es.onerror = () => {
    $('#conn').classList.remove('on');
    $('#conn-text').textContent = 'reconnecting';
  };
}

init().then(connectSSE);
</script>
</body>
</html>
`;
