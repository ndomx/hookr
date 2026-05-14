const express = require('express');
const { forwardRequest } = require('../forwarder');

const router = express.Router();

router.get('/events', (req, res) => {
  req.app.locals.broker.attach(res);
});

router.get('/requests', (req, res) => {
  res.json(req.app.locals.store.list());
});

router.post('/clear', (req, res) => {
  req.app.locals.store.clear();
  res.sendStatus(204);
});

router.post('/forward', async (req, res) => {
  const { id, target, overrideMethod, preserveHost, extraHeaders } = req.body || {};
  if (!id || !target) return res.status(400).json({ error: 'id and target are required' });

  const rec = req.app.locals.store.find(id);
  if (!rec) return res.status(404).json({ error: 'request not found' });

  const result = await forwardRequest(rec, { target, overrideMethod, preserveHost, extraHeaders });
  req.app.locals.store.addForward(id, result);
  res.status(result.error ? 502 : 200).json(result);
});

module.exports = router;
