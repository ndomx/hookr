const http = require('http');
const https = require('https');
const { URL } = require('url');

const HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

function buildTargetUrl(target, capturedUrl) {
  const url = new URL(target);
  // If target has no path, inherit the captured one
  if (url.pathname === '/' || url.pathname === '') {
    try {
      const captured = new URL('http://x' + capturedUrl);
      url.pathname = captured.pathname;
      url.search = captured.search;
    } catch {}
  }
  return url;
}

function buildHeaders(recHeaders, { preserveHost, targetHost, extra }) {
  const headers = {};
  for (const [k, v] of Object.entries(recHeaders)) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  if (!preserveHost) headers.host = targetHost;
  if (extra && typeof extra === 'object') Object.assign(headers, extra);
  return headers;
}

function forwardRequest(rec, { target, overrideMethod, preserveHost = false, extraHeaders }) {
  return new Promise((resolve) => {
    let targetUrl;
    try { targetUrl = buildTargetUrl(target, rec.url); }
    catch { return resolve({ error: 'invalid target url', target, at: new Date().toISOString() }); }

    const lib = targetUrl.protocol === 'https:' ? https : http;
    const headers = buildHeaders(rec.headers, {
      preserveHost,
      targetHost: targetUrl.host,
      extra: extraHeaders,
    });
    const body = Buffer.from(rec.bodyBase64, 'base64');
    const startedAt = Date.now();

    const req = lib.request({
      method: overrideMethod || rec.method,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      headers,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const respBody = Buffer.concat(chunks);
        resolve({
          status: resp.statusCode,
          statusText: resp.statusMessage,
          headers: resp.headers,
          body: respBody.toString('utf8').slice(0, 200_000),
          elapsedMs: Date.now() - startedAt,
          target: targetUrl.toString(),
          at: new Date().toISOString(),
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        error: err.message || String(err),
        target: targetUrl.toString(),
        at: new Date().toISOString(),
      });
    });

    if (body.length) req.write(body);
    req.end();
  });
}

module.exports = { forwardRequest };
