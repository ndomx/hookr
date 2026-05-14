const express = require('express');
const path = require('path');
const { RequestStore } = require('./store');
const { SseBroker } = require('./sse');
const apiRoutes = require('./routes/api');
const captureRoute = require('./routes/capture');

const MAX_BODY_BYTES = 25 * 1024 * 1024;

function createApp({ maxRequests = 500 } = {}) {
  const app = express();
  const store = new RequestStore({ max: maxRequests });
  const broker = new SseBroker();

  store.on('request', (rec) => broker.broadcast('request', rec));
  store.on('forward', (payload) => broker.broadcast('forward', payload));
  store.on('clear', () => broker.broadcast('clear', {}));

  app.locals.store = store;
  app.locals.broker = broker;

  app.use('/', express.static(path.join(__dirname, '..', 'public')));

  // JSON parser is only needed for internal API endpoints
  app.use('/__', express.json({ limit: '1mb' }));
  app.use('/__', apiRoutes);

  // Everything else: capture as raw bytes
  app.use(express.raw({ type: '*/*', limit: MAX_BODY_BYTES }));
  app.use(captureRoute);

  return app;
}

module.exports = { createApp };
