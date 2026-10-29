'use strict';

// Docker-only source simulator. Modes affect subsequent real HTTP GETs; this
// fixture never publishes MQTT, inserts SQL, or invents observation timestamps.
const http = require('node:http');
if (process.env.HOUSE_E2E_ISOLATED !== '1') {
  console.error('Disposable HOUSE E2E acknowledgement required');
  process.exit(1);
}

if (process.argv[2] === '--healthcheck') {
  const request = http.get('http://127.0.0.1:8089/healthz', response => {
    response.resume();
    response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1));
    response.on('error', () => process.exit(1));
  });
  request.setTimeout(1000, () => request.destroy());
  request.on('error', () => process.exit(1));
} else {
  const values = { positive: '1549.4', negative: '-800.5', zero: '0', error: null };
  let mode = 'positive';
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=us-ascii');
    response.setHeader('Cache-Control', 'no-store');
    request.resume();
    if (request.method === 'GET' && request.url === '/healthz') {
      return response.end('ready\n');
    }
    if (request.method === 'GET' && request.url === '/dev/powerValue.txt') {
      if (mode === 'error') {
        response.writeHead(503);
        return response.end('unavailable\n');
      }
      return response.end(`1 2 3 4 5 6 ${values[mode]}\n`);
    }
    const selected = /^\/mode\/(positive|negative|zero|error)$/.exec(request.url);
    if (request.method === 'POST' && selected) {
      mode = selected[1];
      response.writeHead(204);
      return response.end();
    }
    response.writeHead(404);
    response.end('not found\n');
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 2000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 16;
  server.on('error', () => { console.error('HOUSE source fixture unavailable'); process.exit(1); });
  server.listen(8089, '0.0.0.0');
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
