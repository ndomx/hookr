const express = require('express');
const { URL } = require('url');

const router = express.Router();

router.all('*', (req, res) => {
  // express.raw with type:'*/*' yields a Buffer; default to empty buffer if absent.
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const urlObj = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`);

  const rec = req.app.locals.store.add({
    method: req.method,
    url: req.originalUrl,
    path: urlObj.pathname,
    query: Object.fromEntries(urlObj.searchParams),
    headers: req.headers,
    remoteAddr: req.ip,
    body,
  });

  res.json({ ok: true, id: rec.id, capturedAt: rec.at });
});

module.exports = router;
