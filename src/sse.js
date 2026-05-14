class SseBroker {
  constructor() {
    this.clients = new Set();
  }

  attach(res) {
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders?.();
    res.write(`event: hello\ndata: {}\n\n`);

    this.clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 25_000);

    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch {}
    }
  }
}

module.exports = { SseBroker };
