(() => {
  const $ = (s) => document.querySelector(s);
  const listEl = $('#list');
  const detailEl = $('#detail');
  const countEl = $('#count');
  const toastEl = $('#toast');

  let items = [];
  let activeId = null;

  $('#endpoint').textContent = location.origin + '/<your-path>';

  // ---------- helpers ----------

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 1500);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function tryPretty(text, contentType) {
    if (!text) return '';
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('json') || /^\s*[{[]/.test(text)) {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch {}
    }
    return text;
  }

  function toCurl(r) {
    const parts = ['curl -X ' + r.method];
    for (const [k, v] of Object.entries(r.headers)) {
      if (k === 'host' || k === 'content-length') continue;
      parts.push('  -H ' + JSON.stringify(k + ': ' + v));
    }
    if (r.bodyText) parts.push('  --data-raw ' + JSON.stringify(r.bodyText));
    parts.push('  ' + JSON.stringify('http://TARGET' + r.url));
    return parts.join(' \\\n');
  }

  // ---------- rendering ----------

  function renderList() {
    countEl.textContent = items.length;
    listEl.innerHTML = items.map((r) => {
      const time = new Date(r.at).toLocaleTimeString();
      return `<div class="item ${r.id === activeId ? 'active' : ''}" data-id="${r.id}">
        <div class="top">
          <span class="method m-${r.method}">${r.method}</span>
          <span class="path">${escapeHtml(r.url)}</span>
        </div>
        <div class="meta">${time} · ${r.bodySize}b · ${escapeHtml(r.remoteAddr || '')}</div>
      </div>`;
    }).join('');
  }

  function renderForwardResult(f) {
    if (f.error) {
      return `<div class="forward-result err">→ ${escapeHtml(f.target)} — <strong>ERROR:</strong> ${escapeHtml(f.error)}</div>`;
    }
    return `<div class="forward-result ${f.status < 400 ? 'ok' : 'err'}">
      → ${escapeHtml(f.target)} — <strong>${f.status} ${escapeHtml(f.statusText || '')}</strong> (${f.elapsedMs}ms)
      ${f.body ? `<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--muted)">response body</summary><pre style="max-height:200px">${escapeHtml(f.body)}</pre></details>` : ''}
    </div>`;
  }

  function renderDetail() {
    const r = items.find((x) => x.id === activeId);
    if (!r) {
      detailEl.className = 'empty';
      detailEl.textContent = "Send a request to any path on this server — it'll appear here.";
      return;
    }
    detailEl.className = '';

    const headerRows = Object.entries(r.headers).map(
      ([k, v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`
    ).join('');

    const bodyDisplay = r.textual
      ? tryPretty(r.bodyText, r.headers['content-type'])
      : `(binary, ${r.bodySize} bytes — base64 below)\n\n${r.bodyBase64}`;

    detailEl.innerHTML = `
      <div class="section">
        <h3>Forward <span style="text-transform:none;color:var(--muted);font-weight:normal">— replay this request to another URL</span></h3>
        <div class="forward-bar">
          <select id="fwd-method">
            <option value="">${r.method} (keep)</option>
            <option>GET</option><option>POST</option><option>PUT</option>
            <option>PATCH</option><option>DELETE</option>
          </select>
          <input id="fwd-url" placeholder="https://example.com  (path/query preserved if target has none)" />
          <button id="fwd-send" class="primary">Forward →</button>
        </div>
        <div id="forwards">${(r.forwards || []).map(renderForwardResult).join('')}</div>
      </div>

      <div class="section">
        <h3>Request <button data-copy="curl">copy as curl</button></h3>
        <div class="kv">
          <div class="k">method</div><div class="v">${r.method}</div>
          <div class="k">url</div><div class="v">${escapeHtml(r.url)}</div>
          <div class="k">remote</div><div class="v">${escapeHtml(r.remoteAddr || '')}</div>
          <div class="k">at</div><div class="v">${r.at}</div>
          <div class="k">id</div><div class="v">${r.id}</div>
        </div>
      </div>

      <div class="section">
        <h3>Headers</h3>
        <div class="kv">${headerRows}</div>
      </div>

      <div class="section">
        <h3>Body
          <button data-copy="body">copy body</button>
          ${r.textual ? '<button data-copy="bodyPretty">copy pretty</button>' : ''}
          <span style="color:var(--muted);font-weight:normal;text-transform:none">${r.bodySize} bytes</span>
        </h3>
        <pre>${escapeHtml(bodyDisplay)}</pre>
      </div>
    `;

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

  // ---------- actions ----------

  async function forwardActive() {
    const target = $('#fwd-url').value.trim();
    if (!target) { toast('enter a target URL'); return; }
    const overrideMethod = $('#fwd-method').value || undefined;
    const btn = $('#fwd-send');
    btn.disabled = true; btn.textContent = 'sending…';
    try {
      const resp = await fetch('/__/forward', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: activeId, target, overrideMethod }),
      });
      const data = await resp.json();
      if (data.error) toast('error: ' + data.error);
      else toast(`forwarded → ${data.status}`);
    } catch {
      toast('network error');
    } finally {
      btn.disabled = false; btn.textContent = 'Forward →';
    }
  }

  // ---------- wiring ----------

  listEl.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    activeId = item.dataset.id;
    renderList();
    renderDetail();
  });

  $('#clear').addEventListener('click', async () => {
    if (!confirm('Clear all captured requests?')) return;
    await fetch('/__/clear', { method: 'POST' });
  });

  function connectSSE() {
    const es = new EventSource('/__/events');
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

  async function init() {
    const resp = await fetch('/__/requests');
    items = await resp.json();
    renderList();
    connectSSE();
  }

  init();
})();
