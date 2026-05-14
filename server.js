#!/usr/bin/env node
const { createApp } = require('./src/app');

const PORT = Number(process.argv[2] || process.env.PORT || 3000);

const app = createApp();
app.listen(PORT, () => {
  console.log(`hookr listening on http://localhost:${PORT}`);
  console.log(`  UI:       http://localhost:${PORT}/`);
  console.log(`  capture:  any other path → captured`);
});
