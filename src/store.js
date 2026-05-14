const { EventEmitter } = require('events');
const crypto = require('crypto');

function isTextual(headers, body) {
  const ct = (headers['content-type'] || '').toLowerCase();
  if (/json|text|xml|form-urlencoded|javascript|html|csv/.test(ct)) return true;
  if (body.length === 0) return true;
  const sample = body.subarray(0, 1024);
  for (const b of sample) if (b === 0) return false;
  return true;
}

class RequestStore extends EventEmitter {
  constructor({ max = 500 } = {}) {
    super();
    this.max = max;
    this.items = []; // newest first
  }

  add({ method, url, path, query, headers, remoteAddr, body }) {
    const textual = isTextual(headers, body);
    const rec = {
      id: crypto.randomBytes(6).toString('hex'),
      at: new Date().toISOString(),
      method,
      url,
      path,
      query,
      headers,
      remoteAddr,
      bodyBase64: body.toString('base64'),
      bodyText: textual ? body.toString('utf8') : null,
      bodySize: body.length,
      textual,
      forwards: [],
    };
    this.items.unshift(rec);
    if (this.items.length > this.max) this.items.length = this.max;
    this.emit('request', rec);
    return rec;
  }

  list() {
    return this.items;
  }

  find(id) {
    return this.items.find((r) => r.id === id);
  }

  addForward(id, result) {
    const rec = this.find(id);
    if (!rec) return null;
    rec.forwards.unshift(result);
    this.emit('forward', { id, result });
    return rec;
  }

  clear() {
    this.items.length = 0;
    this.emit('clear');
  }
}

module.exports = { RequestStore };
